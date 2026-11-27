import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  APPLICATION_OAUTH_CALLBACK_PATH,
  APPLICATION_OAUTH_START_PATH,
  handleApplicationOAuthRequest,
  resolveApplicationOAuthConfig,
} from "../dist/mcp-unit.mjs";

const APP_SECRET = "oauth-contract-registration-secret";
const ENV = {
  GUANLAN_APP_ID: "guanlan.test.instance",
  GUANLAN_APP_SECRET_SHA256: createHash("sha256").update(APP_SECRET).digest("hex"),
  GUANLAN_MANIFEST_REVISION: "1",
  MCP_RESOURCE_URL: "https://guanlan.example/mcp",
  CLOUD_AUTH_ISSUER: "https://auth.example.com",
};
const MANAGE_ENV = { ...ENV, GUANLAN_WEB_SESSION_SECRET: "W".repeat(43) };
const CODE = "mca_v1." + "A".repeat(22) + "." + "B".repeat(43);
const ACCESS_TOKEN = "mas_v1." + "C".repeat(22) + "." + "D".repeat(43);

function cookieValue(response, name) {
  const raw = response.headers.get("set-cookie") ?? "";
  const marker = name + "=";
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const rest = raw.slice(start + marker.length);
  const end = rest.search(/[;,]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function flowCookie(state, verifier) {
  return "__Host-guanlan_oauth_state=" + state +
    "; __Host-guanlan_oauth_verifier=" + verifier;
}

test("OAuth config is one HTTPS Mira ID origin bound to the application instance", () => {
  const config = resolveApplicationOAuthConfig(ENV);
  assert.ok(config);
  assert.equal(config.base, "https://auth.example.com");
  assert.equal(config.instance.appId, ENV.GUANLAN_APP_ID);
  assert.equal(config.instance.callback, "https://guanlan.example/auth/callback");
  assert.equal(
    resolveApplicationOAuthConfig({ ...ENV, CLOUD_AUTH_ISSUER: "http://auth.example.com" }),
    null,
  );
  assert.equal(
    resolveApplicationOAuthConfig({ ...ENV, CLOUD_AUTH_ISSUER: "https://auth.example.com/path" }),
    null,
  );
});

test("OAuth start emits PKCE S256 and short-lived Secure HttpOnly flow cookies", async () => {
  const response = await handleApplicationOAuthRequest(
    new Request("https://guanlan.example" + APPLICATION_OAUTH_START_PATH),
    ENV,
  );
  assert.equal(response.status, 302);

  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://auth.example.com");
  assert.equal(location.pathname, "/v1/oauth/authorize");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("client_id"), "https://guanlan.example/oauth-client");
  assert.equal(location.searchParams.get("redirect_uri"), "https://guanlan.example/auth/callback");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");

  const state = location.searchParams.get("state");
  const verifier = cookieValue(response, "__Host-guanlan_oauth_verifier");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expectedChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(location.searchParams.get("code_challenge"), expectedChallenge);

  const cookies = response.headers.get("set-cookie");
  assert.match(cookies, /__Host-guanlan_oauth_state=/);
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /Secure/i);
  assert.match(cookies, /SameSite=Lax/i);
  assert.match(cookies, /Max-Age=300/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("OAuth callback establishes a short-lived Guanlan management session without persisting the Mira ID token", async () => {
  const start = await handleApplicationOAuthRequest(
    new Request("https://guanlan.example" + APPLICATION_OAUTH_START_PATH),
    ENV,
  );
  const authorize = new URL(start.headers.get("location"));
  const state = authorize.searchParams.get("state");
  const verifier = cookieValue(start, "__Host-guanlan_oauth_verifier");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const identity = {
    issuer: "mira:cloud-auth",
    subject: "account-sensitive-id",
    audience: "https://guanlan.example/oauth-client",
    appId: ENV.GUANLAN_APP_ID,
    expiresAt,
  };
  let calls = 0;
  const fetchFn = async (input, init) => {
    calls += 1;
    const url = new URL(input);
    if (calls === 1) {
      assert.equal(url.href, "https://auth.example.com/v1/oauth/token");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("client_id"), "https://guanlan.example/oauth-client");
      assert.equal(body.get("redirect_uri"), "https://guanlan.example/auth/callback");
      assert.equal(body.get("code"), CODE);
      assert.equal(body.get("code_verifier"), verifier);
      return Response.json({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 1800,
        ...identity,
      });
    }
    assert.equal(url.href, "https://auth.example.com/v1/oauth/application-session");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer " + ACCESS_TOKEN);
    return Response.json(identity);
  };

  const response = await handleApplicationOAuthRequest(
    new Request(
      "https://guanlan.example" + APPLICATION_OAUTH_CALLBACK_PATH +
        "?code=" + encodeURIComponent(CODE) +
        "&state=" + encodeURIComponent(state),
      { headers: { cookie: flowCookie(state, verifier) } },
    ),
    MANAGE_ENV,
    fetchFn,
  );
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /观澜已连接/);
  assert.match(html, /打开管理界面/);
  assert.match(html, /临时 Mira ID access token 未持久化/);
  assert.match(response.headers.get("set-cookie"), /__Host-guanlan_manage=/);
  assert.equal(html.includes(ACCESS_TOKEN), false);
  assert.equal(html.includes("account-sensitive-id"), false);
  assert.equal(html.includes(CODE), false);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
});

test("OAuth callback rejects a mismatched state before any token exchange", async () => {
  let called = false;
  const response = await handleApplicationOAuthRequest(
    new Request(
      "https://guanlan.example" + APPLICATION_OAUTH_CALLBACK_PATH +
        "?code=" + encodeURIComponent(CODE) +
        "&state=" + "x".repeat(43),
      { headers: { cookie: flowCookie("y".repeat(43), "z".repeat(43)) } },
    ),
    ENV,
    async () => {
      called = true;
      throw new Error("must not fetch");
    },
  );
  assert.equal(called, false);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid_state/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
});

test("OAuth callback rejects a token for another application before session confirmation", async () => {
  const state = "s".repeat(43);
  const verifier = "v".repeat(43);
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  let calls = 0;
  const response = await handleApplicationOAuthRequest(
    new Request(
      "https://guanlan.example" + APPLICATION_OAUTH_CALLBACK_PATH +
        "?code=" + encodeURIComponent(CODE) +
        "&state=" + state,
      { headers: { cookie: flowCookie(state, verifier) } },
    ),
    ENV,
    async () => {
      calls += 1;
      return Response.json({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 1800,
        expiresAt,
        issuer: "mira:cloud-auth",
        subject: "account-a",
        audience: "https://other.example/oauth-client",
        appId: ENV.GUANLAN_APP_ID,
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid_application_session/);
});
