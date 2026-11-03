#!/usr/bin/env node
/**
 * GLN-014 token acquisition / inspection skeleton.
 *
 * The real token can only come from Cloud Auth (GLN-013). This script is the
 * thin, fail-closed scaffolding around that dependency:
 *
 *   plan       (default) show exactly which inputs and endpoints are needed and
 *              whether they are present. NEVER touches the network.
 *   verify     offline verification of a token against a *local* JWKS file using
 *              the real Guanlan verifier (`src/mcp/auth.ts`, bundled with esbuild).
 *   self-test  fully offline proof that the verify path works: generates an
 *              ephemeral Ed25519 key, signs one contract-conformant token and
 *              verifies it. No secrets, no network, no files left behind.
 *   fetch      the ONE network mode. Requires BOTH `--allow-network` and
 *              `GLN014_ALLOW_NETWORK=yes`. It is a maintainer/operator step, not
 *              something CI or a normal task run may execute. It never prints the
 *              Cloud Session or the issued token.
 *
 * Safety rules enforced here:
 *   - no key, session or token is ever hardcoded or echoed;
 *   - anything but the Guanlan audience is refused before a request is built;
 *   - a non-HTTPS base URL (except localhost) is refused;
 *   - missing inputs fail closed with a non-zero exit code, never with a
 *     "probably fine" fallback;
 *   - only whitelisted projections are printed (audience, scope list, expiry, and
 *     a truncated SHA-256 fingerprint of the token).
 *
 * Exit codes: 0 ok, 2 missing/invalid configuration (fail-closed), 3 verification
 * failed, 4 network mode refused.
 */
import { build } from "esbuild";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const BUNDLE_DIR = "dist/gln014";
const BUNDLE = `${BUNDLE_DIR}/contract-bundle.mjs`;
const ENTRY = "tests/gln014-contract-entry.ts";

const DEFAULT_AUDIENCE = "mira:cloud-guanlan";
const DEFAULT_TOKEN_ISSUER = "mira:cloud-auth";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const argOf = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? "");
};
const hasFlag = name => process.argv.includes(name);

const mode = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "plan";
const audience = argOf("--audience", process.env.MIRA_GUANLAN_AUDIENCE?.trim() || DEFAULT_AUDIENCE);
const tokenIssuer = DEFAULT_TOKEN_ISSUER;

/** Only a truncated digest may ever be printed; the token itself stays secret. */
const fingerprint = token => createHash("sha256").update(token).digest("hex").slice(0, 12);

const die = (code, message) => {
  console.error(`FAIL  ${message}`);
  process.exit(code);
};

async function loadVerifier() {
  await mkdir(BUNDLE_DIR, { recursive: true });
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: BUNDLE,
    logLevel: "warning",
  });
  return import(pathToFileURL(BUNDLE).href);
}

function secureBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return url;
  return null;
}

/** ---------------------------------------------------------------- plan mode */
function plan() {
  const baseUrl = process.env.MIRA_CLOUD_AUTH_BASE_URL?.trim() ?? "";
  const session = process.env.MIRA_CLOUD_SESSION_TOKEN?.trim() ?? "";
  const jwksUrl = process.env.CLOUD_AUTH_JWKS_URL?.trim() ?? "";
  const resourceUrl = process.env.MCP_RESOURCE_URL?.trim() ?? "";
  const base = baseUrl ? secureBase(baseUrl) : null;
  const problems = [];

  if (!baseUrl) problems.push("MIRA_CLOUD_AUTH_BASE_URL is unset (Cloud Auth issuance origin)");
  else if (!base) problems.push("MIRA_CLOUD_AUTH_BASE_URL must be https (localhost http allowed)");
  if (!session) problems.push("MIRA_CLOUD_SESSION_TOKEN is unset (device-bound Cloud Session bearer)");
  if (!jwksUrl) problems.push("CLOUD_AUTH_JWKS_URL is unset (informational: Guanlan verifies the token)");
  if (!resourceUrl) problems.push("MCP_RESOURCE_URL is unset (informational: the deployed /mcp URL)");
  if (audience !== DEFAULT_AUDIENCE) {
    problems.push(
      `audience '${audience}' is not '${DEFAULT_AUDIENCE}'; Guanlan rejects any other value (src/mcp/config.ts:93-96)`,
    );
  }

  const sessionProjection = session
    ? `present (sha256:${fingerprint(session)}, ${session.length} chars)`
    : "MISSING";

  console.log("GLN-014 token plan (no network is used by this mode)\n");
  console.log(`mode                : plan`);
  console.log(`cloud auth base     : ${base ? base.href : "(unresolved)"}`);
  console.log(`issuance endpoint   : ${base ? new URL("/v1/service-credentials", base).href : "(unresolved)"}`);
  console.log(`request body        : ${JSON.stringify({ audience })}`);
  console.log(`session bearer      : ${sessionProjection}`);
  console.log(`jwks url (expected) : ${jwksUrl || "(unset)"}`);
  console.log(`mcp resource url    : ${resourceUrl || "(unset)"}`);
  console.log(`expected iss        : ${tokenIssuer}`);
  console.log(`expected aud        : ${audience}`);
  console.log(`expected scopes     : at least guanlan.read (write decisions need guanlan.write)`);
  console.log(`expected claims     : iss, aud, sub, consumer_id (consumer_id = Cloud Account id per maintainer ruling), exp`);
  console.log(`header              : Authorization: Bearer <session>  (never printed)`);
  console.log("");

  if (problems.length > 0) {
    console.error("Fail-closed: this plan is not executable yet.");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(2);
  }
  console.log("All required inputs are present. The next step (network) is a maintainer action:");
  console.log("  node scripts/gln-014-token-fetch.mjs fetch --allow-network");
  console.log("Required alongside: GLN014_ALLOW_NETWORK=yes");
}

/** -------------------------------------------------------------- verify mode */
async function verifyOffline({ token, jwks }) {
  const contract = await loadVerifier();
  const verifier = contract.createCloudAuthVerifier({
    issuer: tokenIssuer,
    audience,
    jwksUrl: new URL("https://offline.invalid/.well-known/jwks.json"),
    consumerClaim: "consumer_id",
    keySet: createLocalJWKSet(jwks),
  });

  const principal = await verifier.verifyAccessToken(token);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const expIso = new Date(principal.expiresAt * 1000).toISOString();
  const ttl = payload.iat ? principal.expiresAt - payload.iat : null;

  console.log("PASS  token satisfies the Guanlan resource contract");
  console.log(`  iss            : ${principal.issuer}`);
  console.log(`  aud            : ${principal.audience}`);
  console.log(`  sub (sha256)   : ${fingerprint(principal.accountId)} (raw value not printed)`);
  console.log(`  consumer_id    : ${fingerprint(principal.consumerId)} (raw value not printed)`);
  console.log(`  consumer==acct : ${principal.consumerId === principal.accountId ? "yes (maintainer ruling)" : "NO — contract expects consumer_id = Cloud Account id"}`);
  console.log(`  scopes         : ${principal.scopes.join(" ") || "(none)"}`);
  console.log(`  write scope    : ${principal.scopes.includes("guanlan.write") ? "present" : "absent (read-only credential)"}`);
  console.log(`  exp            : ${expIso}`);
  console.log(`  ttl (seconds)  : ${ttl ?? "unknown"} ${ttl !== null && ttl > 300 ? "(warning: ruling expects <= 300s)" : ""}`);
  console.log(`  token (sha256) : ${fingerprint(token)}`);

  if (principal.consumerId !== principal.accountId) {
    console.error("Contract warning: maintainer ruling ① sets consumer_id = Cloud Account id.");
    return 3;
  }
  if (ttl !== null && ttl > 300) {
    console.error("Contract warning: ruling ③ expects a short TTL (<= 300s).");
    return 3;
  }
  return 0;
}

async function verifyMode() {
  const tokenFile = argOf("--token-file");
  const jwksFile = argOf("--jwks-file", process.env.GLN014_JWKS_FILE ?? "");
  const token = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : (process.env.GLN014_TOKEN?.trim() ?? "");
  if (!token) die(2, "verification needs a token: set GLN014_TOKEN or pass --token-file <path>");
  if (!jwksFile) die(2, "verification needs a local JWKS file: pass --jwks-file <path>");
  let jwks;
  try {
    jwks = JSON.parse(await readFile(jwksFile, "utf8"));
  } catch (error) {
    die(2, `JWKS file could not be read as JSON: ${error.message}`);
  }
  try {
    return await verifyOffline({ token, jwks });
  } catch (error) {
    console.error(`FAIL  token rejected by the real Guanlan verifier: ${error?.message ?? error}`);
    return 3;
  }
}

/** ------------------------------------------------------------ self-test mode */
async function selfTest() {
  const contract = await loadVerifier();
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = { ...(await exportJWK(publicKey)), kid: "gln014-selftest", alg: "EdDSA", use: "sig" };
  const accountId = "selftest-account";
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: tokenIssuer,
    aud: audience,
    sub: accountId,
    consumer_id: accountId,
    device_id: "selftest-device",
    scope: ["guanlan.read", "guanlan.write"],
    iat: now,
    nbf: now,
    exp: now + 300,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "gln014-selftest" })
    .sign(privateKey);

  const verifier = contract.createCloudAuthVerifier({
    issuer: tokenIssuer,
    audience,
    jwksUrl: new URL("https://offline.invalid/.well-known/jwks.json"),
    consumerClaim: "consumer_id",
    keySet: createLocalJWKSet({ keys: [jwk] }),
  });
  const principal = await verifier.verifyAccessToken(token);
  const ok =
    principal.accountId === accountId &&
    principal.consumerId === accountId &&
    principal.scopes.includes("guanlan.read") &&
    principal.scopes.includes("guanlan.write") &&
    principal.audience === audience;
  console.log(`${ok ? "PASS" : "FAIL"}  offline self-test: contract-conformant token verified by the real verifier`);
  console.log(`  scopes=${principal.scopes.join(" ")} aud=${principal.audience} exp=${new Date(principal.expiresAt * 1000).toISOString()}`);
  console.log("  (ephemeral key pair; nothing written outside dist/, no network)");

  // A token without the consumer claim must fail even when everything else is right.
  const badToken = await new SignJWT({
    iss: tokenIssuer,
    aud: audience,
    sub: accountId,
    device_id: "selftest-device",
    scope: ["guanlan.read"],
    exp: now + 300,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "gln014-selftest" })
    .sign(privateKey);
  let rejected = false;
  try {
    await verifier.verifyAccessToken(badToken);
  } catch (error) {
    rejected = /invalid_token/.test(String(error?.message ?? error));
  }
  console.log(`${rejected ? "PASS" : "FAIL"}  offline self-test: token without consumer_id is rejected`);
  return ok && rejected ? 0 : 3;
}

/** --------------------------------------------------------------- fetch mode */
async function fetchMode() {
  if (!hasFlag("--allow-network") || process.env.GLN014_ALLOW_NETWORK !== "yes") {
    die(
      4,
      "network fetch refused. This mode is a maintainer step: pass --allow-network and set GLN014_ALLOW_NETWORK=yes.",
    );
  }
  const base = secureBase(process.env.MIRA_CLOUD_AUTH_BASE_URL?.trim() ?? "");
  const session = process.env.MIRA_CLOUD_SESSION_TOKEN?.trim() ?? "";
  if (!base) die(2, "MIRA_CLOUD_AUTH_BASE_URL must be an https origin (localhost http allowed)");
  if (!session) die(2, "MIRA_CLOUD_SESSION_TOKEN is unset");
  if (audience !== DEFAULT_AUDIENCE) die(2, `refusing to request audience '${audience}'`);

  const endpoint = new URL("/v1/service-credentials", base);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ audience }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  // Only Cloud Auth's documented, already-public fields are read from the body.
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const code = typeof payload?.error?.code === "string" ? payload.error.code : "unknown_error";
    die(3, `issuance failed: HTTP ${response.status} ${code}`);
  }
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!token) die(3, "issuance returned no token");
  console.log("PASS  Cloud Auth returned a service credential");
  console.log(`  audience       : ${payload.audience ?? audience}`);
  console.log(`  expiresAt      : ${payload.expiresAt ?? "(absent)"}`);
  console.log(`  token (sha256) : ${fingerprint(token)}`);
  console.log("  The token itself is not printed. Persist it only in the isolated test environment.");
  console.log("  Next: node scripts/gln-014-token-fetch.mjs verify --token-file <file> --jwks-file <file>");
  return 0;
}

/** -------------------------------------------------------------------- main */
const CLEANUP = [];

try {
  let code;
  switch (mode) {
    case "plan":
      plan();
      code = 0;
      break;
    case "verify":
      code = await verifyMode();
      break;
    case "self-test":
      code = await selfTest();
      break;
    case "fetch":
      code = await fetchMode();
      break;
    default:
      die(2, `unknown mode '${mode}' (expected plan|verify|self-test|fetch)`);
  }
  process.exitCode = code;
} finally {
  for (const path of CLEANUP) await rm(path, { recursive: true, force: true });
  // Nothing outside dist/ is written; keep an explicit reminder for readers.
  void join(tmpdir(), "unused");
}
