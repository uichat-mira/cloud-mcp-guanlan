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
} finally {
  rmSync(configPath, { force: true });
}
