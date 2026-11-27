import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { issueManagementSessionCookie } from "../dist/manage.mjs";

const APP_SECRET = "gln016-app-secret";
const SESSION_SECRET = "M".repeat(43);
const ORIGIN = "https://guanlan.example";
const BINDINGS = {
  MCP_RESOURCE_URL: ORIGIN + "/mcp",
  CLOUD_AUTH_ISSUER: "https://auth.example.com",
  CLOUD_AUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
  GUANLAN_APP_ID: "guanlan.manage.test",
  GUANLAN_APP_SECRET_SHA256: createHash("sha256").update(APP_SECRET).digest("hex"),
  GUANLAN_MANIFEST_REVISION: "1",
  GUANLAN_WEB_SESSION_SECRET: SESSION_SECRET,
};
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
];
const CF = "https://developers.cloudflare.com/changelog/rss/index.xml";
const HN = "https://hnrss.org/newest?count=5";
const LEGACY = "https://example.com/legacy.xml";
const stamp = "2026-11-27T04:00:00.000Z";

async function withWorker(run) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    bindings: BINDINGS,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000116" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of MIGRATIONS) {
      const sql = await readFile(path, "utf8");
      for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await run({ mf, db });
  } finally {
    await mf.dispose();
  }
}

const insert = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
const rows = async (db, sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;

async function seed(db) {
  await insert(db,
    "INSERT INTO poc_sources(id,url,interval_hours,due_at,last_status,last_checked_at,retry_count) VALUES(?,?,?,?,?,?,?)",
    "src-cf", CF, 1, "2026-11-27T06:00:00.000Z", "success", "2026-11-27T05:00:00.000Z", 0);
  await insert(db,
    "INSERT INTO poc_sources(id,url,interval_hours,due_at,last_status,last_error,last_checked_at,retry_count) VALUES(?,?,?,?,?,?,?,?)",
    "src-hn", HN, 2, "2026-11-27T05:40:00.000Z", "failed", "feed_http_503", "2026-11-27T05:10:00.000Z", 2);
  await insert(db,
    "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
    "legacy", LEGACY, 1, stamp);

  for (const account of ["account-a", "account-b"]) {
    await insert(db, "INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", account, stamp);
    await insert(db, "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      account, account, stamp);
  }
  await insert(db,
    "INSERT INTO guanlan_account_subscriptions(account_id,source_id,interval_hours,created_at) VALUES(?,?,?,?)",
    "account-b", "src-hn", 3, stamp);
  await insert(db,
    "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
    "account-a", "keyword", "AI", stamp);
}

async function sessionCookie(subject="account-a") {
  const headers = new Headers();
  const issued = await issueManagementSessionCookie(headers, {
    issuer: "mira:cloud-auth",
    subject,
    audience: ORIGIN + "/oauth-client",
    appId: BINDINGS.GUANLAN_APP_ID,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }, BINDINGS);
  assert.equal(issued, true);
  return headers.get("set-cookie").split(";")[0];
}

async function post(mf, cookie, body, origin=ORIGIN) {
  return mf.dispatchFetch(ORIGIN + "/manage/subscriptions", {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "manual",
  });
}

test("real workerd/D1 management route reads only the authenticated account and exposes source health", async () => {
  await withWorker(async ({ mf, db }) => {
    await seed(db);
    const unauth = await mf.dispatchFetch(ORIGIN + "/manage", { redirect: "manual" });
    assert.equal(unauth.status, 302);
    assert.equal(unauth.headers.get("location"), "/auth/start");

    const cookie = await sessionCookie();
    const response = await mf.dispatchFetch(ORIGIN + "/manage", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const html = await response.text();
    assert.match(html, /配置与采集/);
    assert.match(html, /Cloudflare changelog RSS/);
    assert.match(html, /Hacker News RSS/);
    assert.match(html, /feed_http_503/);
    assert.match(html, />AI</);
    assert.equal(html.includes("account-b"), false);
    assert.equal(html.includes('name="accountId"'), false);
    assert.equal(html.includes('name="consumerId"'), false);

    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions WHERE account_id='account-a'"))[0].n, 0);
  });
});

test("real workerd/D1 management writes reuse GLN-011 account/consumer mutation semantics", async () => {
  await withWorker(async ({ mf, db }) => {
    await seed(db);
    const cookie = await sessionCookie();

    let response = await post(mf, cookie,
      new URLSearchParams({ level: "account", op: "upsert", sourceId: "src-cf", intervalHours: "4" }).toString());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/manage?notice=updated");
    assert.deepEqual(await rows(db,
      "SELECT account_id,source_id,interval_hours FROM guanlan_account_subscriptions WHERE account_id=?",
      "account-a"), [{ account_id: "account-a", source_id: "src-cf", interval_hours: 4 }]);
    assert.deepEqual(await rows(db,
      "SELECT account_id,source_id,interval_hours FROM guanlan_account_subscriptions WHERE account_id=?",
      "account-b"), [{ account_id: "account-b", source_id: "src-hn", interval_hours: 3 }]);

    response = await post(mf, cookie,
      new URLSearchParams({ level: "consumer", op: "upsert", sourceId: "src-cf", intervalHours: "8" }).toString());
    assert.equal(response.status, 303);
    assert.deepEqual(await rows(db,
      "SELECT account_id,consumer_id,source_id,interval_hours FROM guanlan_consumer_subscriptions WHERE account_id=?",
      "account-a"), [{ account_id: "account-a", consumer_id: "account-a", source_id: "src-cf", interval_hours: 8 }]);

    const page = await mf.dispatchFetch(ORIGIN + "/manage", { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /有效：both · 8h/);
    assert.match(html, /4 小时/);
    assert.match(html, /8 小时/);

    response = await post(mf, cookie,
      new URLSearchParams({ level: "consumer", op: "remove", sourceId: "src-cf" }).toString());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/manage?notice=removed");
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions WHERE account_id='account-a'"))[0].n, 0);
    assert.equal((await rows(db,
      "SELECT interval_hours FROM guanlan_account_subscriptions WHERE account_id='account-a' AND source_id='src-cf'"))[0].interval_hours, 4);
  });
});

test("management POST rejects CSRF, subject injection, invalid intervals and unapproved sources without cross-tenant writes", async () => {
  await withWorker(async ({ mf, db }) => {
    await seed(db);
    const cookie = await sessionCookie();

    let response = await post(mf, cookie,
      new URLSearchParams({ level: "account", op: "upsert", sourceId: "src-cf", intervalHours: "4" }).toString(),
      "https://evil.example");
    assert.equal(response.status, 403);

    response = await post(mf, cookie,
      new URLSearchParams({
        level: "account", op: "upsert", sourceId: "src-cf", intervalHours: "4", accountId: "account-b",
      }).toString());
    assert.equal(response.status, 400);

    response = await post(mf, cookie,
      new URLSearchParams({ level: "account", op: "upsert", sourceId: "src-cf", intervalHours: "25" }).toString());
    assert.equal(response.status, 400);

    response = await post(mf, cookie,
      new URLSearchParams({ level: "account", op: "upsert", sourceId: "legacy", intervalHours: "1" }).toString());
    assert.equal(response.status, 404);
    assert.match(await response.text(), /source_not_approved/);

    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions WHERE account_id='account-a'"))[0].n, 0);
    assert.deepEqual(await rows(db,
      "SELECT account_id,source_id,interval_hours FROM guanlan_account_subscriptions WHERE account_id='account-b'"),
      [{ account_id: "account-b", source_id: "src-hn", interval_hours: 3 }]);
  });
});

test("management storage failure is explicit instead of rendering an empty configuration", async () => {
  await withWorker(async ({ mf, db }) => {
    await seed(db);
    const cookie = await sessionCookie();
    await db.prepare("DROP TABLE guanlan_account_subscriptions").run();

    const response = await mf.dispatchFetch(ORIGIN + "/manage", { headers: { cookie } });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /暂时无法读取配置/);
    assert.match(html, /management_storage_unavailable/);
    assert.doesNotMatch(html, /暂无关注点/);
  });
});
