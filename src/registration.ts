/**
 * GLN-015 · Cloud Auth → Guanlan account-space registration receiver.
 *
 * Cloud Auth (GLN-012) owns the durable delivery intent and the signed sender
 * contract; Guanlan owns its own account space. This module is the receiving
 * half: a single non-public endpoint that turns one authenticated delivery into
 * the `guanlan_accounts` + `guanlan_consumers` rows that the read path and the
 * MCP verifier already require.
 *
 * Sender contract (verbatim from `cloud-auth` `apps/api/src/guanlan-registration.ts`):
 *   POST <MIRA_GUANLAN_REGISTRATION_URL>            (https only)
 *   content-type: application/json
 *   x-mira-timestamp: <unix seconds>
 *   x-mira-signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *   body: {"version":1,"accountId":"<Cloud Auth account id>"}
 *   success = HTTP 2xx and body {accountId: <same>, registered: true}
 *
 * Non-2xx makes Cloud Auth retry (bounded budget, exponential backoff). A
 * handler therefore must never answer 2xx for anything it did not durably
 * commit, and must never use a 2xx to signal a business refusal.
 *
 * Security posture:
 * - fail closed: without a usable secret the endpoint is closed, not open;
 * - bounded input: body size and timestamp window are checked before parsing;
 * - constant-time signature comparison, no timing or detail oracle on failure;
 * - no identity is derived from anything but the signed body;
 * - writes are insert-only: this path can never mutate subscriptions, interests,
 *   the ledger and never reactivates a space that was torn down or deleted.
 */
import type { D1Database } from "@cloudflare/workers-types";

export const REGISTRATION_PATH = "/internal/guanlan-registrations";
/** The signed payload is a short JSON object; anything larger is hostile. */
export const MAX_REGISTRATION_BODY_BYTES = 4096;
/** Symmetric maximum skew. Matches the Cloud Auth receiver contract fixture. */
export const REGISTRATION_TIMESTAMP_WINDOW_SECONDS = 300;
/** Cloud Auth refuses to configure a shorter secret, so neither do we. */
export const REGISTRATION_SECRET_MIN_LENGTH = 32;

export type RegistrationEnv = {
  DB: D1Database;
  /**
   * Shared HMAC secret provisioned with `wrangler secret put`. Never committed,
   * never logged, never echoed back to the caller.
   */
  MIRA_GUANLAN_REGISTRATION_SECRET?: string;
};

/** Closed set of externally visible failures. No internal state is exposed. */
export type RegistrationErrorCode =
  | "method_not_allowed"
  | "registration_not_configured"
  | "payload_too_large"
  | "invalid_timestamp"
  | "invalid_signature"
  | "invalid_request"
  | "space_state_conflict"
  | "registration_unavailable";

const STATUS: Readonly<Record<RegistrationErrorCode, 400 | 401 | 405 | 409 | 413 | 500 | 503>> = Object.freeze({
  method_not_allowed: 405,
  registration_not_configured: 503,
  payload_too_large: 413,
  invalid_timestamp: 401,
  invalid_signature: 401,
  invalid_request: 400,
  space_state_conflict: 409,
  registration_unavailable: 500,
});

const fail = (code: RegistrationErrorCode): Response =>
  Response.json({ error: code }, { status: STATUS[code] });

const encoder = new TextEncoder();

/**
 * Verify the signature with the platform's HMAC verify, which compares the
 * supplied MAC in constant time. There is deliberately no `===` on secrets or
 * digests anywhere in this file, and no length-varying early exit beyond the
 * public hex shape check.
 */
async function hmacVerified(secret: string, message: string, signatureHex: string): Promise<boolean> {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    const byte = Number.parseInt(signatureHex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) return false;
    bytes[index] = byte;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message));
}

/**
 * Header and payload validation, in the order that fails cheapest first.
 * Returns either the accepted account id or the exact failure to answer with.
 */
type Accepted = { ok: true; accountId: string };
type Rejected = { ok: false; code: RegistrationErrorCode };

const SIGNATURE_HEADER = "x-mira-signature";
const TIMESTAMP_HEADER = "x-mira-timestamp";
const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/;
const TIMESTAMP_SHAPE = /^\d{1,11}$/;

export async function verifyRegistrationRequest(
  request: Request,
  secret: string,
  nowMs: number,
): Promise<Accepted | Rejected> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return { ok: false, code: "invalid_request" };
    if (parsed > MAX_REGISTRATION_BODY_BYTES) return { ok: false, code: "payload_too_large" };
  }

  const timestampHeader = request.headers.get(TIMESTAMP_HEADER);
  if (timestampHeader === null || !TIMESTAMP_SHAPE.test(timestampHeader)) {
    return { ok: false, code: "invalid_timestamp" };
  }
  const timestamp = Number(timestampHeader);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > REGISTRATION_TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, code: "invalid_timestamp" };
  }

  // The signature covers the exact bytes Cloud Auth signed: header value, a dot,
  // then the raw body. Reading the body first is required, and the size bound is
  // enforced again on the decoded length because a missing content-length is not
  // proof of a small body.
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_REGISTRATION_BODY_BYTES) {
    return { ok: false, code: "payload_too_large" };
  }

  const signatureHeader = request.headers.get(SIGNATURE_HEADER);
  if (signatureHeader === null || !SIGNATURE_SHAPE.test(signatureHeader)) {
    return { ok: false, code: "invalid_signature" };
  }
  if (!(await hmacVerified(secret, `${timestampHeader}.${body}`, signatureHeader.slice("sha256=".length)))) {
    return { ok: false, code: "invalid_signature" };
  }

  // Signature is valid, so the body is ours; still treat it as untrusted data.
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, code: "invalid_request" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, code: "invalid_request" };
  }
  const record = payload as { version?: unknown; accountId?: unknown };
  if (record.version !== 1) return { ok: false, code: "invalid_request" };
  if (typeof record.accountId !== "string") return { ok: false, code: "invalid_request" };

  // Mirror the D1 CHECK on `guanlan_accounts.account_id` exactly, so a value that
  // passes here can never be rejected by the database for shape reasons.
  const accountId = record.accountId;
  if (accountId.length < 1 || accountId.length > 128 || accountId !== accountId.trim()) {
    return { ok: false, code: "invalid_request" };
  }

  return { ok: true, accountId };
}

type SpaceState = { account: boolean; consumer: boolean; receipt: boolean };

async function readSpaceState(db: D1Database, accountId: string): Promise<SpaceState> {
  const [account, consumer, receipt] = await Promise.all([
    db.prepare("SELECT 1 AS present FROM guanlan_accounts WHERE account_id = ?")
      .bind(accountId).first<{ present: number }>(),
    db.prepare("SELECT 1 AS present FROM guanlan_consumers WHERE account_id = ? AND consumer_id = ?")
      .bind(accountId, accountId).first<{ present: number }>(),
    db.prepare("SELECT 1 AS present FROM guanlan_registration_receipts WHERE account_id = ?")
      .bind(accountId).first<{ present: number }>(),
  ]);
  return { account: account !== null, consumer: consumer !== null, receipt: receipt !== null };
}

/**
 * Decide what a delivery means for this account, then apply the minimal write.
 *
 * | account | consumer | receipt | meaning                                   | action |
 * | ------- | -------- | ------- | ----------------------------------------- | ------ |
 * | absent  | absent   | absent  | first registration                        | create |
 * | present | present  | any     | duplicate delivery                        | touch  |
 * | present | absent   | any     | space torn down by an operator            | refuse |
 * | absent  | absent   | present | account deleted after registration        | refuse |
 *
 * "absent + present" cannot happen (foreign key) and is treated as a conflict.
 * Every write is guarded by the same predicates inside one atomic batch, so a
 * concurrent delete cannot let a stale delivery recreate the space.
 */
export async function applyRegistration(
  db: D1Database,
  accountId: string,
  nowIso: string,
): Promise<RegistrationErrorCode | null> {
  const before = await readSpaceState(db, accountId);

  const tornDown = before.account && !before.consumer;
  const deletedAfterDelivery = !before.account && before.receipt;
  const impossible = !before.account && before.consumer;
  if (tornDown || deletedAfterDelivery || impossible) return "space_state_conflict";

  // Exactly one receipt statement runs per delivery, so a first registration and
  // a duplicate are both counted once. Running both an insert and a touch on the
  // same request would double-count the first delivery.
  if (before.receipt) {
    await db.batch([
      // A stale delivery may never resurrect a removed consumer space, so the
      // touch is conditional on the space still being complete.
      db.prepare(`UPDATE guanlan_registration_receipts
        SET last_delivered_at = ?, deliveries = deliveries + 1
        WHERE account_id = ?
          AND EXISTS (SELECT 1 FROM guanlan_consumers WHERE account_id = ? AND consumer_id = ?)`)
        .bind(nowIso, accountId, accountId, accountId),
    ]);
  } else {
    await db.batch([
      // No receipt means this account never registered here; a receipt that
      // appears later always wins over recreation (guarded below).
      db.prepare(`INSERT OR IGNORE INTO guanlan_accounts(account_id, created_at)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM guanlan_registration_receipts WHERE account_id = ?)`)
        .bind(accountId, nowIso, accountId),
      db.prepare(`INSERT OR IGNORE INTO guanlan_consumers(account_id, consumer_id, created_at)
        SELECT ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM guanlan_accounts WHERE account_id = ?)
          AND NOT EXISTS (SELECT 1 FROM guanlan_registration_receipts WHERE account_id = ?)`)
        .bind(accountId, accountId, nowIso, accountId, accountId),
      // Recorded only when the space really exists, so a refused or lost creation
      // can never leave a receipt that would block a later legitimate delivery.
      db.prepare(`INSERT OR IGNORE INTO guanlan_registration_receipts(
          account_id, first_delivered_at, last_delivered_at, deliveries)
        SELECT ?, ?, ?, 1
        WHERE EXISTS (SELECT 1 FROM guanlan_accounts WHERE account_id = ?)
          AND EXISTS (SELECT 1 FROM guanlan_consumers WHERE account_id = ? AND consumer_id = ?)`)
        .bind(accountId, nowIso, nowIso, accountId, accountId, accountId),
    ]);
  }

  // Verify what the database actually contains instead of assuming the batch
  // succeeded: the answer Cloud Auth records as "delivered" must be true.
  const after = await readSpaceState(db, accountId);
  if (after.account && after.consumer && after.receipt) return null;
  return "space_state_conflict";
}

export async function handleRegistration(
  request: Request,
  env: RegistrationEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (request.method !== "POST") return fail("method_not_allowed");

  const secret = env.MIRA_GUANLAN_REGISTRATION_SECRET?.trim() ?? "";
  if (secret.length < REGISTRATION_SECRET_MIN_LENGTH) return fail("registration_not_configured");

  const verified = await verifyRegistrationRequest(request, secret, nowMs);
  if (!verified.ok) return fail(verified.code);

  try {
    const refusal = await applyRegistration(env.DB, verified.accountId, new Date(nowMs).toISOString());
    if (refusal !== null) return fail(refusal);
  } catch {
    // Storage outage is retryable for Cloud Auth and must not look like success.
    return fail("registration_unavailable");
  }

  return Response.json({ accountId: verified.accountId, registered: true });
}
