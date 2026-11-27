import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  DECIDE_TOOL_NAME,
  NEWS_TOOL_NAME,
  READ_ONLY_ANNOTATIONS,
  WHOAMI_TOOL_NAME,
  WRITE_ANNOTATIONS,
  createCloudAuthVerifier,
  createFixtureVerifier,
  createMcpRuntime,
  resolveMcpConfig,
} from "../dist/mcp-unit.mjs";
import {
  FIXTURE_TOKENS,
  MCP_TEST_APP_ID,
  MCP_TEST_AUDIENCE,
  MCP_TEST_ISSUER,
  MCP_TEST_JWKS_URL,
  MCP_TEST_RESOURCE_URL,
  MCP_TEST_SCOPE,
  MCP_TEST_SERVICE_ID,
  MCP_TEST_TOKEN_ISSUER,
  MCP_TEST_WRITE_SCOPE,
} from "../dist/mcp-fixtures.mjs";

const ENV = {
  MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
  CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
  CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
  GUANLAN_APP_ID: MCP_TEST_APP_ID,
};
const DB = { prepare() { throw new Error("unexpected D1 access in auth tests"); } };
const READER = {
  async listPage() {
    return {
      items: [{
        id: "https://example.com/story",
        title: "Example",
        summary: "Summary",
        url: "https://example.com/story",
        sourceId: "feed-1",
        publishedAt: "2026-10-31T00:00:00.000Z",
        ingestedAt: "2026-10-31T00:01:00.000Z",
        status: "unread",
      }],
      count: 1,
      limit: 20,
      nextCursor: null,
    };
  },
};
const fixtureVerifier = createFixtureVerifier(FIXTURE_TOKENS, {
  issuer: MCP_TEST_TOKEN_ISSUER,
  audience: MCP_TEST_AUDIENCE,
});

const runtime = () => {
  const resolved = createMcpRuntime(
    { ...ENV, DB },
    { verifier: fixtureVerifier, reader: READER },
  );
  assert.equal(resolved.ok, true);
  return resolved.runtime;
};

const request = (init = {}, token) => {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return runtime().fetch(
    new Request(MCP_TEST_RESOURCE_URL, { ...init, headers }),
  );
};

test("config binds one explicit Mira ID application to the exact MCP resource", () => {
  const resolved = resolveMcpConfig(ENV);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.config.resourceUrl.href, MCP_TEST_RESOURCE_URL);
  assert.equal(resolved.config.issuer, MCP_TEST_ISSUER);
  assert.equal(resolved.config.tokenIssuer, MCP_TEST_TOKEN_ISSUER);
  assert.equal(resolved.config.jwksUrl.href, MCP_TEST_JWKS_URL);
  assert.equal(resolved.config.audience, MCP_TEST_RESOURCE_URL);
  assert.equal(resolved.config.appId, MCP_TEST_APP_ID);
  assert.equal(resolved.config.serviceId, MCP_TEST_SERVICE_ID);
  assert.deepEqual(resolved.config.requiredScopes, [MCP_TEST_SCOPE]);

  for (const key of [
    "MCP_RESOURCE_URL",
    "CLOUD_AUTH_ISSUER",
    "CLOUD_AUTH_JWKS_URL",
    "GUANLAN_APP_ID",
  ]) {
    const env = { ...ENV };
    delete env[key];
    assert.equal(resolveMcpConfig(env).ok, false, key);
  }

  assert.equal(
    resolveMcpConfig({
      ...ENV,
      MCP_RESOURCE_URL: "https://127.0.0.1/other",
    }).ok,
    false,
  );
  assert.equal(
    resolveMcpConfig({
      ...ENV,
      MCP_RESOURCE_URL: "https://127.0.0.1/mcp?aud=old",
    }).ok,
    false,
  );
});

test("no token gets 401 with RFC 9728 resource metadata discovery", async () => {
  const response = await request({ method: "POST" });
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate");
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    /resource_metadata="https:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.equal((await response.json()).error, "invalid_token");
});

test("public resource metadata advertises the V1 resource and Guanlan scopes", async () => {
  const response = await runtime().fetch(
    new Request(
      "https://127.0.0.1/.well-known/oauth-protected-resource/mcp",
      {
        headers: {
          host: "127.0.0.1",
          origin: "https://client.example",
        },
      },
    ),
  );
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, MCP_TEST_RESOURCE_URL);
  assert.deepEqual(metadata.authorization_servers, [MCP_TEST_ISSUER]);
  assert.deepEqual(
    metadata.scopes_supported,
    [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
  );
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
});

test("fixture trust remains fail-closed", async () => {
  const cases = [
    ["fixture-wrong-issuer", 401],
    ["fixture-shiyan-audience", 401],
    ["fixture-relay-audience", 401],
    ["fixture-expired", 401],
    ["fixture-missing-consumer", 401],
    ["fixture-wrong-scope", 401],
  ];
  for (const [token, status] of cases) {
    const response = await request(
      {
        method: "GET",
        headers: { accept: "application/json, text/event-stream" },
      },
      token,
    );
    assert.equal(response.status, status, token);
  }
});

test("host and MCP origin validation reject non-canonical callers", async () => {
  const badHost = await runtime().fetch(
    new Request(MCP_TEST_RESOURCE_URL, {
      method: "GET",
      headers: { host: "evil.example.com" },
    }),
  );
  assert.equal(badHost.status, 403);

  const badOrigin = await runtime().fetch(
    new Request(MCP_TEST_RESOURCE_URL, {
      method: "GET",
      headers: {
        host: "127.0.0.1",
        origin: "https://evil.example.com",
      },
    }),
  );
  assert.equal(badOrigin.status, 403);
});

test("modern tools/list and tools/call use the shared capability definitions", async () => {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const listResponse = await request(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify(envelope),
    },
    "fixture-consumer-1",
  );
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("mcp-session-id"), null);
  const body = await listResponse.json();
  const tools = body.result.tools;
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    [DECIDE_TOOL_NAME, NEWS_TOOL_NAME, WHOAMI_TOOL_NAME].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.destructiveHint, false);
    if (tool.name === DECIDE_TOOL_NAME) {
      assert.equal(
        tool.annotations.readOnlyHint,
        WRITE_ANNOTATIONS.readOnlyHint,
      );
      assert.equal(
        tool.annotations.idempotentHint,
        WRITE_ANNOTATIONS.idempotentHint,
      );
      assert.equal(tool.annotations.readOnlyHint, false);
    } else {
      assert.equal(
        tool.annotations.readOnlyHint,
        READ_ONLY_ANNOTATIONS.readOnlyHint,
      );
      assert.equal(tool.annotations.readOnlyHint, true);
    }
  }

  const callResponse = await request(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": WHOAMI_TOOL_NAME,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: WHOAMI_TOOL_NAME,
          arguments: {},
          _meta: envelope.params._meta,
        },
      }),
    },
    "fixture-consumer-2",
  );
  assert.equal(callResponse.status, 200);
  const callBody = await callResponse.json();
  assert.equal(callBody.result.structuredContent.consumerId, "account-c");
  assert.equal(callBody.result.structuredContent.accountId, "account-c");
});

test("missing modern standard headers are rejected as protocol errors", async () => {
  const response = await request(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "test",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    },
    "fixture-consumer-1",
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32020);
});

test("Mira ID V1 credential binds APP_ID, service, resource, account and bounded scopes", async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "EdDSA",
  };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const verifier = createCloudAuthVerifier({
    issuer: MCP_TEST_TOKEN_ISSUER,
    audience: MCP_TEST_AUDIENCE,
    jwksUrl: new URL(MCP_TEST_JWKS_URL),
    appId: MCP_TEST_APP_ID,
    serviceId: MCP_TEST_SERVICE_ID,
    keySet,
  });

  const sign = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: MCP_TEST_TOKEN_ISSUER,
      aud: MCP_TEST_AUDIENCE,
      sub: "account-9",
      device_id: "desktop-test-device",
      app_id: MCP_TEST_APP_ID,
      service_id: MCP_TEST_SERVICE_ID,
      resource: MCP_TEST_RESOURCE_URL,
      scope: [MCP_TEST_SCOPE],
      iat: now,
      nbf: now,
      exp: now + 300,
      ...overrides,
    };
    const {
      iss,
      aud,
      sub,
      iat,
      nbf,
      exp,
      ...custom
    } = claims;
    return new SignJWT(custom)
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt(iat)
      .setNotBefore(nbf)
      .setExpirationTime(exp)
      .sign(privateKey);
  };

  const token = await sign();
  const principal = await verifier.verifyAccessToken(token);
  assert.equal(principal.issuer, MCP_TEST_TOKEN_ISSUER);
  assert.equal(principal.audience, MCP_TEST_RESOURCE_URL);
  assert.equal(principal.accountId, "account-9");
  assert.equal(principal.consumerId, "account-9");
  assert.deepEqual(principal.scopes, [MCP_TEST_SCOPE]);

  const writer = await verifier.verifyAccessToken(
    await sign({ scope: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE] }),
  );
  assert.deepEqual(
    new Set(writer.scopes),
    new Set([MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE]),
  );

  const resolved = createMcpRuntime(
    { ...ENV, DB },
    { verifier, reader: READER },
  );
  assert.equal(resolved.ok, true);

  const call = bearer =>
    resolved.runtime.fetch(
      new Request(MCP_TEST_RESOURCE_URL, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": WHOAMI_TOOL_NAME,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: WHOAMI_TOOL_NAME,
            arguments: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "gln015-signed",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );

  const accepted = await call(token);
  assert.equal(accepted.status, 200);
  assert.equal(
    (await accepted.json()).result.structuredContent.consumerId,
    "account-9",
  );

  const now = Math.floor(Date.now() / 1000);
  const rejects = [
    sign({ iss: "mira:other-issuer" }),
    sign({ aud: "mira:cloud-guanlan" }),
    sign({ resource: "https://other.example/mcp" }),
    sign({ app_id: "other.application" }),
    sign({ service_id: "mail" }),
    sign({ sub: "" }),
    sign({ device_id: "" }),
    sign({ scope: [MCP_TEST_WRITE_SCOPE] }),
    sign({ scope: [MCP_TEST_SCOPE, "unknown.scope"] }),
    sign({ scope: [MCP_TEST_SCOPE, MCP_TEST_SCOPE] }),
    sign({ scope: [123] }),
    sign({ exp: now - 60 }),
    sign({ iat: now, nbf: now, exp: now + 601 }),
    sign({ unexpected_claim: "not-allowed" }),
  ];
  for (const candidate of rejects) {
    await assert.rejects(
      verifier.verifyAccessToken(await candidate),
      /invalid_token/,
    );
  }
});

test("unconfigured runtime is closed and never constructs a handler", () => {
  const resolved = createMcpRuntime({ DB });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "mcp_resource_url");
});
