import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const required = [
  "GLN015_CANARY_ALLOW",
  "GLN015_WORKER_NAME",
  "GLN015_D1_DATABASE_ID",
  "GUANLAN_APP_ID",
  "GUANLAN_APP_SECRET",
  "GUANLAN_MANIFEST_REVISION",
  "MCP_RESOURCE_URL",
  "CLOUD_AUTH_ISSUER",
  "CLOUD_AUTH_JWKS_URL",
];

for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
if (process.env.GLN015_CANARY_ALLOW !== "yes") {
  throw new Error("Refusing canary deployment without GLN015_CANARY_ALLOW=yes");
}

const workerName = process.env.GLN015_WORKER_NAME;
if (!/^cloud-guanlan-gln014-[a-z0-9-]+$/.test(workerName)) {
  throw new Error("GLN015_WORKER_NAME must target the retained GLN-014 isolated worker");
}

const appId = process.env.GUANLAN_APP_ID;
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(appId)) {
  throw new Error("GUANLAN_APP_ID is invalid");
}
if (process.env.GUANLAN_APP_SECRET.length < 16 || process.env.GUANLAN_APP_SECRET.length > 512) {
  throw new Error("GUANLAN_APP_SECRET length is invalid");
}
if (!/^[0-9]+$/.test(process.env.GUANLAN_MANIFEST_REVISION) ||
    Number(process.env.GUANLAN_MANIFEST_REVISION) < 1) {
  throw new Error("GUANLAN_MANIFEST_REVISION must be a positive integer");
}
if (!/^[0-9a-f-]{36}$/i.test(process.env.GLN015_D1_DATABASE_ID)) {
  throw new Error("GLN015_D1_DATABASE_ID must be a UUID");
}

const resource = new URL(process.env.MCP_RESOURCE_URL);
if (
  resource.protocol !== "https:" ||
  resource.pathname !== "/mcp" ||
  resource.search ||
  resource.hash ||
  !resource.hostname.endsWith(".workers.dev") ||
  !resource.hostname.startsWith(workerName + ".")
) {
  throw new Error("MCP_RESOURCE_URL must be the exact retained canary workers.dev /mcp URL");
}
for (const key of ["CLOUD_AUTH_ISSUER", "CLOUD_AUTH_JWKS_URL"]) {
  const url = new URL(process.env[key]);
  if (url.protocol !== "https:") throw new Error(`${key} must be HTTPS`);
}

const configPath = resolve(".gln015-canary.wrangler.json");
const config = {
  name: workerName,
  main: "src/index.ts",
  compatibility_date: "2026-08-06",
  workers_dev: true,
  preview_urls: true,
  d1_databases: [
    {
      binding: "DB",
      database_name: workerName,
      database_id: process.env.GLN015_D1_DATABASE_ID,
      migrations_dir: "migrations",
    },
  ],
  vars: {
    GUANLAN_APP_ID: appId,
    GUANLAN_MANIFEST_REVISION: process.env.GUANLAN_MANIFEST_REVISION,
    MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL,
    CLOUD_AUTH_ISSUER: process.env.CLOUD_AUTH_ISSUER,
    CLOUD_AUTH_JWKS_URL: process.env.CLOUD_AUTH_JWKS_URL,
  },
};

const run = (args, options = {}) => {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", ...args, "--config", configPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
      input: options.input,
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
};

try {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

  // Deploy code and non-secret bindings first. This canary is isolated and has
  // no Cron trigger; a brief application_not_configured window is acceptable.
  run(["deploy"]);

  // Secret material never enters the generated config, repository or stdout.
  run(["secret", "put", "GUANLAN_APP_SECRET"], {
    input: process.env.GUANLAN_APP_SECRET + "\n",
  });

  const base = resource.origin;
  const expectJson = async (url, expectedStatus, init) => {
    const response = await fetch(url, init);
    if (response.status !== expectedStatus) {
      throw new Error(`Smoke check ${new URL(url).pathname} returned ${response.status}; expected ${expectedStatus}`);
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { response, body };
  };

  const health = await expectJson(base + "/health", 200);
  if (health.body?.status !== "ok" || health.body?.product !== "观澜 Guanlan") {
    throw new Error("Health payload does not identify the Guanlan product");
  }

  const manifestResult = await expectJson(base + "/.well-known/mira-application", 200);
  const manifest = manifestResult.body;
  if (
    manifest?.schemaVersion !== "1" ||
    manifest?.appId !== appId ||
    manifest?.name !== "观澜 Guanlan" ||
    manifest?.services?.length !== 1 ||
    manifest.services[0]?.serviceId !== "news" ||
    manifest.services[0]?.resource !== process.env.MCP_RESOURCE_URL ||
    manifest.services[0]?.protocol?.version !== "2026-07-28"
  ) {
    throw new Error("Mira ID application manifest did not match the GLN-015 instance contract");
  }
  if (JSON.stringify(manifest).includes(process.env.GUANLAN_APP_SECRET)) {
    throw new Error("Application secret leaked into the public manifest");
  }

  const registration = await expectJson(base + "/mira/verify-registration", 200, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appId,
      appSecret: process.env.GUANLAN_APP_SECRET,
    }),
  });
  if (registration.body?.ok !== true || registration.body?.appId !== appId) {
    throw new Error("Registration verification response was invalid");
  }

  const metadata = await expectJson(base + "/.well-known/oauth-protected-resource/mcp", 200);
  if (
    metadata.body?.resource !== process.env.MCP_RESOURCE_URL ||
    !Array.isArray(metadata.body?.authorization_servers) ||
    !metadata.body.authorization_servers.includes(process.env.CLOUD_AUTH_ISSUER)
  ) {
    throw new Error("Protected-resource metadata did not bind the V1 resource");
  }

  await expectJson(base + "/mcp", 401, { method: "POST" });
  await expectJson(base + "/internal/guanlan-registrations", 404, { method: "POST" });

  console.log(JSON.stringify({
    status: "PASS",
    check: "gln-015-canary",
    worker: workerName,
    appId,
    resource: process.env.MCP_RESOURCE_URL,
  }));
} finally {
  rmSync(configPath, { force: true });
}
