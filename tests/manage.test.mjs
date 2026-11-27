import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GUANLAN_MANAGE_SCOPE,
  MANAGEMENT_SESSION_COOKIE,
  MANAGEMENT_SESSION_TTL_SECONDS,
  issueManagementSessionCookie,
  readManagementSession,
  renderManagementPage,
} from "../dist/manage.mjs";

const APP_SECRET = "manage-test-app-secret";
const SESSION_SECRET = "S".repeat(43);
const ENV = {
  GUANLAN_APP_ID: "guanlan.manage.test",
  GUANLAN_APP_SECRET_SHA256: createHash("sha256").update(APP_SECRET).digest("hex"),
  GUANLAN_MANIFEST_REVISION: "1",
  MCP_RESOURCE_URL: "https://guanlan.example/mcp",
  GUANLAN_WEB_SESSION_SECRET: SESSION_SECRET,
};
const NOW = Date.parse("2026-11-27T05:30:00.000Z");
const IDENTITY = {
  issuer: "mira:cloud-auth",
  subject: "account-sensitive-id",
  audience: "https://guanlan.example/oauth-client",
  appId: ENV.GUANLAN_APP_ID,
  expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
};

function cookieHeader(setCookie) {
  return setCookie.split(";")[0];
}

test("management session is short-lived, HttpOnly and bound to the Guanlan application", async () => {
  const headers = new Headers();
  assert.equal(await issueManagementSessionCookie(headers, IDENTITY, ENV, NOW), true);
  const setCookie = headers.get("set-cookie");
  assert.equal(setCookie.startsWith(MANAGEMENT_SESSION_COOKIE + "="), true);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, new RegExp("Max-Age=" + MANAGEMENT_SESSION_TTL_SECONDS));

  const session = await readManagementSession(
    new Request("https://guanlan.example/manage", { headers: { cookie: cookieHeader(setCookie) } }),
    ENV,
    NOW + 1_000,
  );
  assert.equal(session.ok, true);
  assert.equal(session.principal.accountId, IDENTITY.subject);
  assert.equal(session.principal.consumerId, IDENTITY.subject);
  assert.deepEqual(session.principal.scopes, [GUANLAN_MANAGE_SCOPE]);
  assert.deepEqual(session.authorities, ["account", "consumer"]);
  assert.equal(session.principal.audience, IDENTITY.audience);
});

test("management session rejects tampering, expiry and application drift", async () => {
  const headers = new Headers();
  await issueManagementSessionCookie(headers, IDENTITY, ENV, NOW);
  const cookie = cookieHeader(headers.get("set-cookie"));

  const [name, value] = cookie.split("=");
  const tampered = name + "=" + value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
  assert.deepEqual(
    await readManagementSession(
      new Request("https://guanlan.example/manage", { headers: { cookie: tampered } }),
      ENV,
      NOW + 1_000,
    ),
    { ok: false, failure: "invalid" },
  );

  assert.deepEqual(
    await readManagementSession(
      new Request("https://guanlan.example/manage", { headers: { cookie } }),
      ENV,
      NOW + (MANAGEMENT_SESSION_TTL_SECONDS + 1) * 1_000,
    ),
    { ok: false, failure: "expired" },
  );

  assert.deepEqual(
    await readManagementSession(
      new Request("https://other.example/manage", { headers: { cookie } }),
      { ...ENV, MCP_RESOURCE_URL: "https://other.example/mcp" },
      NOW + 1_000,
    ),
    { ok: false, failure: "invalid" },
  );
});

test("management session is unavailable without a valid dedicated signing secret", async () => {
  const request = new Request("https://guanlan.example/manage");
  assert.deepEqual(
    await readManagementSession(request, { ...ENV, GUANLAN_WEB_SESSION_SECRET: undefined }, NOW),
    { ok: false, failure: "not_configured" },
  );
  const headers = new Headers();
  assert.equal(
    await issueManagementSessionCookie(
      headers,
      IDENTITY,
      { ...ENV, GUANLAN_WEB_SESSION_SECRET: "too-short" },
      NOW,
    ),
    false,
  );
  assert.equal(headers.get("set-cookie"), null);
});

test("management page renders effective configuration without exposing identity write fields or unsafe HTML", () => {
  const html = renderManagementPage({
    accountId: '<account onmouseover="x">',
    consumerId: "consumer-a",
    sources: [{
      sourceId: "src-1",
      label: '<script>alert("x")</script>',
      url: "https://example.com/?a=1&b=2",
      registered: true,
      schedulerIntervalHours: 1,
      dueAt: "2026-11-27T06:00:00.000Z",
      lastStatus: "failed",
      lastError: '<img src=x onerror="x">',
      lastCheckedAt: "2026-11-27T05:00:00.000Z",
      retryCount: 2,
      accountIntervalHours: 4,
      consumerIntervalHours: 8,
      effectiveOrigin: "both",
      effectiveIntervalHours: 8,
      effectiveIntervalSource: "consumer",
    }],
    interests: [{ kind: "keyword", value: "<AI>", origin: "account" }],
  }, { notice: "updated" });

  assert.match(html, /配置与采集/);
  assert.match(html, /账户共享订阅/);
  assert.match(html, /当前消费者覆盖/);
  assert.match(html, /自定义 RSS \/ Atom/);
  assert.match(html, /尚未开放/);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;img src=x onerror=&quot;x&quot;&gt;/);
  assert.match(html, /&lt;AI&gt;/);
  assert.equal(html.includes('name="accountId"'), false);
  assert.equal(html.includes('name="consumerId"'), false);
  assert.match(html, /name="sourceId"/);
  assert.match(html, /name="intervalHours"/);
});
