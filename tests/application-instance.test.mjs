import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  APPLICATION_MANIFEST_PATH,
  APPLICATION_VERIFY_PATH,
  applicationManifest,
  handleApplicationRequest,
  resolveApplicationInstance,
} from "../dist/mcp-unit.mjs";

const TEST_SECRET = "guanlan-test-secret-at-least-32-bytes";
const ENV = {
  GUANLAN_APP_ID: "guanlan.test.instance",
  GUANLAN_APP_SECRET_SHA256: createHash("sha256").update(TEST_SECRET).digest("hex"),
  GUANLAN_MANIFEST_REVISION: "1",
  MCP_RESOURCE_URL: "https://guanlan.example/mcp",
};

test("Guanlan publishes one Mira ID V1 application with one standard MCP news service", () => {
  const instance = resolveApplicationInstance(ENV);
  assert.ok(instance);
  const manifest = applicationManifest(instance);

  assert.equal(manifest.schemaVersion, "1");
  assert.equal(manifest.appId, ENV.GUANLAN_APP_ID);
  assert.equal(manifest.projectId, "guanlan");
  assert.equal(manifest.name, "观澜 Guanlan");
  assert.equal(manifest.homeUrl, "https://guanlan.example/");
  assert.equal(manifest.manifestRevision, 1);
  assert.equal(manifest.oauth.clientId, "https://guanlan.example/oauth-client");
  assert.deepEqual(
    manifest.oauth.redirectUris,
    ["https://guanlan.example/auth/callback"],
  );
  assert.equal(
    manifest.registrationVerification.endpoint,
    "https://guanlan.example" + APPLICATION_VERIFY_PATH,
  );

  assert.equal(manifest.services.length, 1);
  const service = manifest.services[0];
  assert.equal(service.serviceId, "news");
  assert.equal(service.name, "观澜新闻服务");
  assert.equal(service.type, "mcp");
  assert.equal(service.protocol.name, "mcp");
  assert.equal(service.protocol.version, "2026-07-28");
  assert.equal(service.protocol.endpoint, ENV.MCP_RESOURCE_URL);
  assert.equal(service.resource, ENV.MCP_RESOURCE_URL);
  assert.deepEqual(service.scopes, ["guanlan.read", "guanlan.write"]);

  const refs = service.capabilities.flatMap(capability => capability.toolRefs);
  assert.deepEqual(
    new Set(refs),
    new Set(["guanlan_whoami", "guanlan_news_recent", "guanlan_news_decide"]),
  );
  assert.equal(new Set(refs).size, refs.length);

  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /GUANLAN_APP_SECRET|test-secret|SHA256/);
});

test("application discovery and registration proof compare only the AppSecret digest", async () => {
  const discovery = await handleApplicationRequest(
    new Request("https://guanlan.example" + APPLICATION_MANIFEST_PATH),
    ENV,
  );
  assert.equal(discovery.status, 200);
  const manifest = await discovery.json();
  assert.equal(manifest.appId, ENV.GUANLAN_APP_ID);
  assert.equal(discovery.headers.get("cache-control"), "no-store");

  const verified = await handleApplicationRequest(
    new Request("https://guanlan.example" + APPLICATION_VERIFY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: ENV.GUANLAN_APP_ID,
        appSecret: TEST_SECRET,
      }),
    }),
    ENV,
  );
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    ok: true,
    appId: ENV.GUANLAN_APP_ID,
  });

  const rejected = await handleApplicationRequest(
    new Request("https://guanlan.example" + APPLICATION_VERIFY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: ENV.GUANLAN_APP_ID,
        appSecret: "wrong-secret-at-least-16",
      }),
    }),
    ENV,
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "registration_rejected" });

  const browserPost = await handleApplicationRequest(
    new Request("https://guanlan.example" + APPLICATION_VERIFY_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://guanlan.example",
      },
      body: JSON.stringify({
        appId: ENV.GUANLAN_APP_ID,
        appSecret: TEST_SECRET,
      }),
    }),
    ENV,
  );
  assert.equal(browserPost.status, 403);

  const wrongOrigin = await handleApplicationRequest(
    new Request("https://mirror.example" + APPLICATION_MANIFEST_PATH),
    ENV,
  );
  assert.equal(wrongOrigin.status, 404);
});

test("application endpoints fail closed when instance identity is incomplete", async () => {
  for (const key of [
    "GUANLAN_APP_ID",
    "GUANLAN_APP_SECRET_SHA256",
    "GUANLAN_MANIFEST_REVISION",
    "MCP_RESOURCE_URL",
  ]) {
    const env = { ...ENV };
    delete env[key];
    assert.equal(resolveApplicationInstance(env), null, key);
    const response = await handleApplicationRequest(
      new Request("https://guanlan.example" + APPLICATION_MANIFEST_PATH),
      env,
    );
    assert.equal(response.status, 503, key);
  }

  assert.equal(
    resolveApplicationInstance({
      ...ENV,
      GUANLAN_APP_SECRET_SHA256: "not-a-sha256-digest",
    }),
    null,
  );
});
