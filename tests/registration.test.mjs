import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleRegistration,
  verifyRegistrationRequest,
  MAX_REGISTRATION_BODY_BYTES,
  REGISTRATION_SECRET_MIN_LENGTH,
  REGISTRATION_TIMESTAMP_WINDOW_SECONDS,
} from "../dist/registration-unit.mjs";

// GLN-015 T1: receiver validation semantics. No Worker, no D1, no network.
// The storage stub throws on any access, so every rejection below is proven to
// happen *before* the database is touched.
const SECRET = "unit-registration-secret-at-least-32-bytes-long";
const ACCOUNT = "6f1a2b3c-4d5e-4f60-8a91-000000000001";
const NOW = 1_800_000_000_000; // fixed clock: 2027-01-15T08:00:00Z

const forbiddenDb = {
  prepare() {
    throw new Error("database must not be touched on a rejected request");
  },
  batch() {
    throw new Error("database must not be touched on a rejected request");
  },
};

// `{ secret: null }` models an environment without the binding at all.
const env = ({ secret = SECRET } = {}) => ({
  DB: forbiddenDb,
  ...(secret === null ? {} : { MIRA_GUANLAN_REGISTRATION_SECRET: secret }),
});

const signature = (timestamp, body, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

function request({
  body = JSON.stringify({ version: 1, accountId: ACCOUNT }),
  timestamp = String(Math.floor(NOW / 1000)),
  signatureHeader = signature(timestamp, body),
  method = "POST",
  headers = {},
} = {}) {
  return new Request("https://127.0.0.1/internal/guanlan-registrations", {
    method,
    headers: {
      "content-type": "application/json",
      ...(timestamp === null ? {} : { "x-mira-timestamp": timestamp }),
      ...(signatureHeader === null ? {} : { "x-mira-signature": signatureHeader }),
      ...headers,
    },
    ...(method === "POST" ? { body } : {}),
  });
}

const errorCode = async response => {
  const payload = await response.json();
  // Errors must never carry internal detail: one closed-enum code, nothing else.
  assert.deepEqual(Object.keys(payload), ["error"], "error body must expose exactly one code");
  return payload.error;
};

test("GLN-015 receiver: only POST is accepted and unsupported methods never reach storage", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handleRegistration(request({ method }), env(), NOW);
    assert.equal(response.status, 405);
    assert.equal(await errorCode(response), "method_not_allowed");
  }
});

test("GLN-015 receiver: an unusable secret closes the endpoint instead of opening it", async () => {
  const cases = [
    { secret: null }, // binding absent
    { secret: "" },
    { secret: "too-short" },
    { secret: "x".repeat(REGISTRATION_SECRET_MIN_LENGTH - 1) },
  ];
  for (const options of cases) {
    const response = await handleRegistration(request(), env(options), NOW);
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), "registration_not_configured");
  }
});

test("GLN-015 receiver: an authenticated request proceeds to storage (no early rejection)", async () => {
  const response = await handleRegistration(request(), env(), NOW);
  // The stub DB throws, so reaching storage is observable as a retryable 500 that
  // still hides internals. Anything else would mean validation rejected this.
  assert.equal(response.status, 500);
  assert.equal(await errorCode(response), "registration_unavailable");
});

test("GLN-015 receiver: the timestamp window is exactly ±300s and inclusive", async () => {
  const nowSeconds = Math.floor(NOW / 1000);
  const at = offset => String(nowSeconds + offset);

  for (const offset of [-REGISTRATION_TIMESTAMP_WINDOW_SECONDS, REGISTRATION_TIMESTAMP_WINDOW_SECONDS]) {
    const body = JSON.stringify({ version: 1, accountId: ACCOUNT });
    const timestamp = at(offset);
    const response = await handleRegistration(
      request({ body, timestamp, signatureHeader: signature(timestamp, body) }), env(), NOW,
    );
    assert.equal(response.status, 500, `offset ${offset} must pass validation and reach storage`);
  }

  for (const offset of [-REGISTRATION_TIMESTAMP_WINDOW_SECONDS - 1, REGISTRATION_TIMESTAMP_WINDOW_SECONDS + 1]) {
    const body = JSON.stringify({ version: 1, accountId: ACCOUNT });
    const timestamp = at(offset);
    const response = await handleRegistration(
      request({ body, timestamp, signatureHeader: signature(timestamp, body) }), env(), NOW,
    );
    assert.equal(response.status, 401);
    assert.equal(await errorCode(response), "invalid_timestamp");
  }
});

test("GLN-015 receiver: timestamp must be ASCII digits and the signature must be well formed", async () => {
  const body = JSON.stringify({ version: 1, accountId: ACCOUNT });
  for (const timestamp of ["", "abc", "-1", "1e9", "1_800_000_000"]) {
    const response = await handleRegistration(
      request({ body, timestamp, signatureHeader: signature(timestamp, body) }), env(), NOW,
    );
    assert.equal(response.status, 401, `timestamp '${timestamp}' must be rejected`);
    assert.equal(await errorCode(response), "invalid_timestamp");
  }

  // The transport normalises header whitespace, so a space-padded timestamp is
  // no longer the string that was signed. It must still be rejected, but the
  // exact code depends on which layer notices first; assert rejection, not a code.
  const padded = " 1800000000";
  const paddedResponse = await handleRegistration(
    request({ body, timestamp: padded, signatureHeader: signature(padded, body) }), env(), NOW,
  );
  assert.equal(paddedResponse.status, 401);
  assert.match(await errorCode(paddedResponse), /^invalid_/);

  for (const signatureHeader of ["", "deadbeef", "sha256=", `sha256=${"A".repeat(64)}`, `md5=${"a".repeat(64)}`]) {
    const response = await handleRegistration(request({ body, signatureHeader }), env(), NOW);
    assert.equal(response.status, 401, `signature '${signatureHeader}' must be rejected`);
    assert.equal(await errorCode(response), "invalid_signature");
  }
});

test("GLN-015 receiver: a signature over different bytes, or from a different secret, is rejected", async () => {
  const body = JSON.stringify({ version: 1, accountId: ACCOUNT });
  const timestamp = String(Math.floor(NOW / 1000));

  const tampered = await handleRegistration(
    request({ body: JSON.stringify({ version: 1, accountId: "other-account" }), timestamp, signatureHeader: signature(timestamp, body) }),
    env(), NOW,
  );
  assert.equal(tampered.status, 401);
  assert.equal(await errorCode(tampered), "invalid_signature");

  const wrongSecret = await handleRegistration(
    request({ body, timestamp, signatureHeader: signature(timestamp, body, "another-secret-at-least-32-bytes-long!") }),
    env(), NOW,
  );
  assert.equal(wrongSecret.status, 401);
  assert.equal(await errorCode(wrongSecret), "invalid_signature");
});

test("GLN-015 receiver: payload schema mirrors the D1 account_id constraints", async () => {
  const bad = [
    { version: 2, accountId: ACCOUNT },
    { accountId: ACCOUNT },
    { version: "1", accountId: ACCOUNT },
    { version: 1, accountId: "" },
    { version: 1, accountId: ` ${ACCOUNT}` },
    { version: 1, accountId: `${ACCOUNT} ` },
    { version: 1, accountId: "a".repeat(129) },
    { version: 1, accountId: 42 },
    { version: 1 },
    [],
    "a string",
    null,
  ];
  for (const payload of bad) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(NOW / 1000));
    const response = await handleRegistration(
      request({ body, timestamp, signatureHeader: signature(timestamp, body) }), env(), NOW,
    );
    assert.equal(response.status, 400, `payload ${body} must be rejected as invalid_request`);
    assert.equal(await errorCode(response), "invalid_request");
  }

  const boundary = JSON.stringify({ version: 1, accountId: "a".repeat(128) });
  const timestamp = String(Math.floor(NOW / 1000));
  const accepted = await handleRegistration(
    request({ body: boundary, timestamp, signatureHeader: signature(timestamp, boundary) }), env(), NOW,
  );
  assert.equal(accepted.status, 500, "128 characters is the accepted upper bound");
});

test("GLN-015 receiver: a body larger than the bound is refused before parsing", async () => {
  const big = JSON.stringify({ version: 1, accountId: ACCOUNT, padding: "x".repeat(MAX_REGISTRATION_BODY_BYTES) });
  assert.ok(big.length > MAX_REGISTRATION_BODY_BYTES);
  const timestamp = String(Math.floor(NOW / 1000));

  const byLength = await handleRegistration(
    request({ body: big, timestamp, signatureHeader: signature(timestamp, big) }), env(), NOW,
  );
  assert.equal(byLength.status, 413);
  assert.equal(await errorCode(byLength), "payload_too_large");

  const byHeader = await handleRegistration(
    request({ body: JSON.stringify({ version: 1, accountId: ACCOUNT }), headers: { "content-length": String(MAX_REGISTRATION_BODY_BYTES + 1) } }),
    env(), NOW,
  );
  assert.equal(byHeader.status, 413, "a declared oversized body is refused without reading it");
  assert.equal(await errorCode(byHeader), "payload_too_large");
});

test("GLN-015 receiver: replayed requests pass validation again (idempotency is proven against real D1)", async () => {
  const first = await handleRegistration(request(), env(), NOW);
  const replay = await handleRegistration(request(), env(), NOW);
  assert.equal(first.status, replay.status);
  assert.equal(first.status, 500, "validation accepts a replay; storage stub is the only failure here");
});

test("GLN-015 receiver: verifyRegistrationRequest is a usable pure surface", async () => {
  const ok = await verifyRegistrationRequest(request(), SECRET, NOW);
  assert.deepEqual(ok, { ok: true, accountId: ACCOUNT });

  const stale = await verifyRegistrationRequest(
    request({ timestamp: String(Math.floor(NOW / 1000) - 301) }), SECRET, NOW,
  );
  assert.deepEqual(stale, { ok: false, code: "invalid_timestamp" });
});
