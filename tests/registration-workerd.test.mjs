import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";

// GLN-015 T2/T3: real workerd Worker + real D1 (never an in-memory SQLite mock).
// The signature helper is written with Node's own HMAC so the accepted path is
// proven against an independent implementation, not against the code under test.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
  "migrations/0005_guanlan_registration_receipts.sql",
];
const SECRET = "workerd-registration-secret-at-least-32-bytes";
const PATH = "/internal/guanlan-registrations";
const BASE = "https://127.0.0.1" + PATH;
const ACCOUNT = "6f1a2b3c-4d5e-4f60-8a91-000000000002";

async function applyMigrations(db) {
  for (const path of MIGRATIONS) {
    const sql = await readFile(path, "utf8");
    for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function withWorker(fn, { secret = SECRET } = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000015" },
    bindings: secret === null ? {} : { MIRA_GUANLAN_REGISTRATION_SECRET: secret },
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db);
    await fn(mf, db);
  } finally {
    await mf.dispose();
  }
}

const sign = (timestamp, body, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

async function deliver(mf, {
  accountId = ACCOUNT,
  version = 1,
  timestamp = nowSeconds(),
  secret = SECRET,
  body,
  headers = {},
  method = "POST",
} = {}) {
  const payload = body ?? JSON.stringify({ version, accountId });
  return mf.dispatchFetch(BASE, {
    method,
    headers: {
      "content-type": "application/json",
      "x-mira-timestamp": timestamp,
      "x-mira-signature": sign(timestamp, payload, secret),
      ...headers,
    },
    ...(method === "POST" ? { body: payload } : {}),
  });
}

const count = async (db, sql, ...args) =>
  (await db.prepare(sql).bind(...args).all()).results[0].n;

const state = async (db, accountId = ACCOUNT) => ({
  accounts: await count(db, "SELECT COUNT(*) AS n FROM guanlan_accounts WHERE account_id = ?", accountId),
  consumers: await count(db, "SELECT COUNT(*) AS n FROM guanlan_consumers WHERE account_id = ?", accountId),
  consumerIds: (await db.prepare("SELECT consumer_id FROM guanlan_consumers WHERE account_id = ?")
    .bind(accountId).all()).results.map(row => row.consumer_id),
  receipts: await count(db, "SELECT COUNT(*) AS n FROM guanlan_registration_receipts WHERE account_id = ?", accountId),
  deliveries: (await db.prepare("SELECT deliveries FROM guanlan_registration_receipts WHERE account_id = ?")
    .bind(accountId).all()).results[0]?.deliveries ?? 0,
});

const privateRows = async db => ({
  subscriptions: await count(db, "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions"),
  consumerSubscriptions: await count(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions"),
  interests: await count(db, "SELECT COUNT(*) AS n FROM guanlan_account_interests"),
  consumerInterests: await count(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_interests"),
  ledger: await count(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"),
});

const assertOnlyErrorCode = async (response, status, code) => {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.equal(payload.error, code);
};

test("GLN-015: a signed registration creates the account space and never touches private data", async () => {
  await withWorker(async (mf, db) => {
    const response = await deliver(mf);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accountId: ACCOUNT, registered: true });

    const after = await state(db);
    assert.equal(after.accounts, 1);
    assert.equal(after.consumers, 1);
    // Maintainer ruling ①: consumer_id equals the Cloud Account id.
    assert.deepEqual(after.consumerIds, [ACCOUNT]);
    assert.equal(after.receipts, 1);
    assert.equal(after.deliveries, 1);

    assert.deepEqual(await privateRows(db), {
      subscriptions: 0, consumerSubscriptions: 0, interests: 0, consumerInterests: 0, ledger: 0,
    });
  });
});

test("GLN-015: duplicate and out-of-order deliveries are idempotent", async () => {
  await withWorker(async (mf, db) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await deliver(mf)).status, 200);
    }
    const after = await state(db);
    assert.equal(after.accounts, 1);
    assert.equal(after.consumers, 1);
    assert.equal(after.deliveries, 3, "each confirmed delivery is counted, the space is not duplicated");

    // A second account arriving between duplicates must not disturb either space.
    const other = "6f1a2b3c-4d5e-4f60-8a91-000000000003";
    assert.equal((await deliver(mf, { accountId: other })).status, 200);
    assert.equal((await deliver(mf)).status, 200);
    assert.deepEqual(await state(db), {
      accounts: 1, consumers: 1, consumerIds: [ACCOUNT], receipts: 1, deliveries: 4,
    });
    assert.deepEqual(await state(db, other), {
      accounts: 1, consumers: 1, consumerIds: [other], receipts: 1, deliveries: 1,
    });
  });
});

test("GLN-015: concurrent duplicate deliveries still produce exactly one space", async () => {
  await withWorker(async (mf, db) => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(mf)));
    for (const response of responses) assert.equal(response.status, 200);
    const after = await state(db);
    assert.equal(after.accounts, 1);
    assert.equal(after.consumers, 1);
    assert.ok(after.deliveries >= 1, "the receipt keeps counting confirmed deliveries");
  });
});

test("GLN-015: every rejected delivery leaves the database untouched", async () => {
  await withWorker(async (mf, db) => {
    const zero = {
      accounts: 0, consumers: 0, consumerIds: [], receipts: 0, deliveries: 0,
    };

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    await assertOnlyErrorCode(
      await deliver(mf, { timestamp: staleTimestamp }), 401, "invalid_timestamp",
    );
    await assertOnlyErrorCode(
      await deliver(mf, { timestamp: String(Math.floor(Date.now() / 1000) + 301) }), 401, "invalid_timestamp",
    );
    await assertOnlyErrorCode(await deliver(mf, { timestamp: "abc" }), 401, "invalid_timestamp");
    await assertOnlyErrorCode(await deliver(mf, { secret: "a-different-secret-at-least-32-bytes-long" }), 401, "invalid_signature");

    // Signature over different bytes than the delivered body.
    const timestamp = nowSeconds();
    const signed = JSON.stringify({ version: 1, accountId: "6f1a2b3c-4d5e-4f60-8a91-000000000004" });
    await assertOnlyErrorCode(
      await deliver(mf, { timestamp, body: JSON.stringify({ version: 1, accountId: ACCOUNT }), headers: { "x-mira-signature": sign(timestamp, signed) } }),
      401, "invalid_signature",
    );

    await assertOnlyErrorCode(await deliver(mf, { version: 2 }), 400, "invalid_request");
    await assertOnlyErrorCode(await deliver(mf, { accountId: "a".repeat(129) }), 400, "invalid_request");
    await assertOnlyErrorCode(await deliver(mf, { accountId: ` ${ACCOUNT}` }), 400, "invalid_request");
    await assertOnlyErrorCode(await deliver(mf, { accountId: `${ACCOUNT} ` }), 400, "invalid_request");
    await assertOnlyErrorCode(await deliver(mf, { body: "not json" }), 400, "invalid_request");

    const oversized = JSON.stringify({ version: 1, accountId: ACCOUNT, padding: "x".repeat(8192) });
    await assertOnlyErrorCode(await deliver(mf, { body: oversized }), 413, "payload_too_large");

    await assertOnlyErrorCode(await deliver(mf, { method: "GET" }), 405, "method_not_allowed");

    assert.deepEqual(await state(db), zero);
    assert.deepEqual(await privateRows(db), {
      subscriptions: 0, consumerSubscriptions: 0, interests: 0, consumerInterests: 0, ledger: 0,
    });
  });
});

test("GLN-015: a worker without the registration secret stays closed", async () => {
  await withWorker(async (mf, db) => {
    await assertOnlyErrorCode(await deliver(mf), 503, "registration_not_configured");
    assert.deepEqual(await state(db), {
      accounts: 0, consumers: 0, consumerIds: [], receipts: 0, deliveries: 0,
    });
  }, { secret: null });
});

test("GLN-015: a torn-down space is never recreated by a stale delivery", async () => {
  await withWorker(async (mf, db) => {
    assert.equal((await deliver(mf)).status, 200);
    await db.prepare("DELETE FROM guanlan_consumers WHERE account_id = ? AND consumer_id = ?").bind(ACCOUNT, ACCOUNT).run();

    await assertOnlyErrorCode(await deliver(mf), 409, "space_state_conflict");
    const after = await state(db);
    assert.equal(after.accounts, 1, "the existing account row is untouched");
    assert.equal(after.consumers, 0, "the removed consumer space must not come back");
  });
});

test("GLN-015: an account deleted after registration is not resurrected", async () => {
  await withWorker(async (mf, db) => {
    assert.equal((await deliver(mf)).status, 200);
    await db.prepare("DELETE FROM guanlan_accounts WHERE account_id = ?").bind(ACCOUNT).run();
    assert.equal((await state(db)).accounts, 0);

    await assertOnlyErrorCode(await deliver(mf), 409, "space_state_conflict");
    const after = await state(db);
    assert.equal(after.accounts, 0, "deleted accounts must not be recreated");
    assert.equal(after.consumers, 0);
    assert.equal(after.receipts, 1, "the receipt is what keeps the deletion recognisable");
  });
});

test("GLN-015: the registration route does not widen the other Worker surfaces", async () => {
  await withWorker(async (mf, db) => {
    const health = await mf.dispatchFetch("https://127.0.0.1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "cloud-guanlan-poc", status: "ok", publicApi: false });

    // No Cloud Auth trust configured in this environment: /mcp must stay closed.
    const mcp = await mf.dispatchFetch("https://127.0.0.1/mcp", { method: "POST" });
    assert.equal(mcp.status, 503);
    assert.equal((await mcp.json()).error, "mcp_not_configured");

    // The registration path is not an MCP route and exposes nothing else.
    assert.equal((await mf.dispatchFetch("https://127.0.0.1" + PATH, { method: "GET" })).status, 405);
    assert.equal((await mf.dispatchFetch("https://127.0.0.1/internal/unknown", { method: "POST" })).status, 404);
    assert.deepEqual(await state(db), {
      accounts: 0, consumers: 0, consumerIds: [], receipts: 0, deliveries: 0,
    });
  });
});
