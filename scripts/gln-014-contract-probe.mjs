#!/usr/bin/env node
/**
 * GLN-014 read-only contract probe.
 *
 * Purpose: prove, by execution, which token shapes the *current dev* Guanlan
 * resource verifier accepts, and whether the *current* Cloud Auth service
 * credential claims can pass it. It bundles the real `src/mcp/auth.ts` /
 * `src/mcp/config.ts` with esbuild and imports them; there is no second
 * implementation of the verifier here and no production module change.
 *
 * It performs no network I/O: the JWKS `keySet` injection point documented in
 * `src/mcp/auth.ts` (test/integration only) is used so a locally generated
 * Ed25519 key can stand in for the Cloud Auth JWKS. That makes the probe
 * evidence about the verifier contract, never about a live Cloud Auth
 * deployment.
 *
 * Usage: node scripts/gln-014-contract-probe.mjs
 * Exit code 0 only when every expectation below holds.
 */
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const OUT_DIR = "dist/gln014";
const BUNDLE = `${OUT_DIR}/contract-bundle.mjs`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function loadContract() {
  await mkdir(OUT_DIR, { recursive: true });
  await build({
    entryPoints: ["tests/gln014-contract-entry.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: BUNDLE,
    logLevel: "warning",
  });
  return import(pathToFileURL(BUNDLE).href);
}

const expectReject = async (verifier, token, name, detail) => {
  try {
    await verifier.verifyAccessToken(token);
    record(name, false, "token was ACCEPTED but must be rejected");
  } catch (error) {
    record(name, /invalid_token/.test(String(error?.message ?? error)), detail);
  }
};

async function main() {
  const contract = await loadContract();
  const {
    createCloudAuthVerifier,
    resolveMcpConfig,
    CLOUD_AUTH_TOKEN_ISSUER,
    GUANLAN_REQUIRED_SCOPE,
    GUANLAN_SERVICE_AUDIENCE,
    GUANLAN_WRITE_SCOPE,
  } = contract;

  // ---------------------------------------------------------------- constants
  record(
    "constants match the documented contract",
    CLOUD_AUTH_TOKEN_ISSUER === "mira:cloud-auth" &&
      GUANLAN_SERVICE_AUDIENCE === "mira:cloud-guanlan" &&
      GUANLAN_REQUIRED_SCOPE === "guanlan.read" &&
      GUANLAN_WRITE_SCOPE === "guanlan.write",
    `iss=${CLOUD_AUTH_TOKEN_ISSUER} aud=${GUANLAN_SERVICE_AUDIENCE} read=${GUANLAN_REQUIRED_SCOPE} write=${GUANLAN_WRITE_SCOPE}`,
  );

  // ------------------------------------------------------------------- config
  const baseEnv = {
    MCP_RESOURCE_URL: "https://guanlan.example.workers.dev/mcp",
    CLOUD_AUTH_ISSUER: "https://cloud-auth.example",
    CLOUD_AUTH_JWKS_URL: "https://cloud-auth.example/.well-known/jwks.json",
    MCP_AUDIENCE: GUANLAN_SERVICE_AUDIENCE,
  };
  const resolved = resolveMcpConfig(baseEnv);
  record(
    "config resolves the Guanlan defaults",
    resolved.ok === true &&
      resolved.config.tokenIssuer === "mira:cloud-auth" &&
      resolved.config.consumerClaim === "consumer_id" &&
      resolved.config.requiredScopes.length === 1 &&
      resolved.config.requiredScopes[0] === GUANLAN_REQUIRED_SCOPE,
    resolved.ok
      ? `tokenIssuer=${resolved.config.tokenIssuer} consumerClaim=${resolved.config.consumerClaim} requiredScopes=${resolved.config.requiredScopes.join(" ")}`
      : `reason=${resolved.reason}`,
  );

  const shiyanAudience = resolveMcpConfig({ ...baseEnv, MCP_AUDIENCE: "mira:cloud-shiyan" });
  record(
    "config rejects a non-Guanlan service audience",
    shiyanAudience.ok === false && shiyanAudience.reason === "mcp_audience_not_guanlan",
    shiyanAudience.ok ? "accepted mira:cloud-shiyan" : shiyanAudience.reason,
  );

  const relayAudience = resolveMcpConfig({ ...baseEnv, MCP_AUDIENCE: "mira:cloud-relay-transport" });
  record(
    "config rejects the Relay transport audience",
    relayAudience.ok === false && relayAudience.reason === "mcp_audience_not_guanlan",
    relayAudience.ok ? "accepted mira:cloud-relay-transport" : relayAudience.reason,
  );

  const noJwks = resolveMcpConfig({ ...baseEnv, CLOUD_AUTH_JWKS_URL: "" });
  record(
    "config fails closed without a JWKS binding",
    noJwks.ok === false && noJwks.reason === "cloud_auth_jwks_url",
    noJwks.ok ? "resolved without JWKS" : noJwks.reason,
  );

  const resourceAudience = resolveMcpConfig({
    ...baseEnv,
    MCP_AUDIENCE: baseEnv.MCP_RESOURCE_URL,
  });
  record(
    "config also accepts the exact /mcp resource URL as audience",
    resourceAudience.ok === true,
    resourceAudience.ok ? "ok" : resourceAudience.reason,
  );

  // ----------------------------------------------------------------- verifier
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = { ...(await exportJWK(publicKey)), kid: "gln014-probe-key", alg: "EdDSA", use: "sig" };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const verifier = createCloudAuthVerifier({
    issuer: CLOUD_AUTH_TOKEN_ISSUER,
    audience: GUANLAN_SERVICE_AUDIENCE,
    jwksUrl: new URL("https://cloud-auth.example/.well-known/jwks.json"),
    consumerClaim: "consumer_id",
    keySet,
  });

  const sign = async (claims) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      iss: CLOUD_AUTH_TOKEN_ISSUER,
      aud: GUANLAN_SERVICE_AUDIENCE,
      sub: "account-probe",
      device_id: "probe-device",
      scope: [GUANLAN_REQUIRED_SCOPE],
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + 300,
      ...claims,
    };
    const token = new SignJWT(payload)
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "gln014-probe-key" })
      .sign(privateKey);
    return token;
  };

  // Exact shape the current cloud-auth signer emits for Shiyan.
  await expectReject(
    verifier,
    await sign({
      aud: "mira:cloud-shiyan",
      scope: ["shiyan:authenticate"],
    }),
    "current Cloud Auth Shiyan credential is rejected by the Guanlan verifier",
    "aud mira:cloud-shiyan, scope shiyan:authenticate",
  );

  // The gap GLN-013 has to close: Cloud Auth claims carry no consumer today.
  await expectReject(
    verifier,
    await sign({ consumer_id: undefined }),
    "Guanlan-audience token without a consumer claim is rejected",
    "no consumer_id claim",
  );

  const accepted = await sign({ consumer_id: "consumer-probe" });
  try {
    const principal = await verifier.verifyAccessToken(accepted);
    record(
      "Guanlan-audience token with consumer_id is accepted",
      principal.accountId === "account-probe" &&
        principal.consumerId === "consumer-probe" &&
        principal.scopes.length === 1 &&
        principal.scopes[0] === GUANLAN_REQUIRED_SCOPE &&
        principal.issuer === CLOUD_AUTH_TOKEN_ISSUER &&
        principal.audience === GUANLAN_SERVICE_AUDIENCE,
      `account=${principal.accountId} consumer=${principal.consumerId} scopes=${principal.scopes.join(" ")}`,
    );
  } catch (error) {
    record("Guanlan-audience token with consumer_id is accepted", false, String(error?.message ?? error));
  }

  const writeToken = await sign({ consumer_id: "consumer-probe", scope: [GUANLAN_REQUIRED_SCOPE, GUANLAN_WRITE_SCOPE] });
  try {
    const principal = await verifier.verifyAccessToken(writeToken);
    record(
      "read+write scope array survives verification unchanged",
      principal.scopes.includes(GUANLAN_WRITE_SCOPE),
      principal.scopes.join(" "),
    );
  } catch (error) {
    record("read+write scope array survives verification unchanged", false, String(error?.message ?? error));
  }

  const spaceDelimited = await sign({ consumer_id: "consumer-probe", scope: `${GUANLAN_REQUIRED_SCOPE} ${GUANLAN_WRITE_SCOPE}` });
  try {
    const principal = await verifier.verifyAccessToken(spaceDelimited);
    record(
      "space-delimited scope string is accepted",
      principal.scopes.length === 2 && principal.scopes.includes(GUANLAN_WRITE_SCOPE),
      principal.scopes.join(" "),
    );
  } catch (error) {
    record("space-delimited scope string is accepted", false, String(error?.message ?? error));
  }

  await expectReject(
    verifier,
    await sign({ consumer_id: "consumer-probe", aud: "mira:cloud-relay-transport" }),
    "Relay audience token is rejected",
    "aud mira:cloud-relay-transport",
  );
  await expectReject(
    verifier,
    await sign({ consumer_id: "consumer-probe", iss: "https://relay.example.com" }),
    "foreign issuer is rejected",
    "iss https://relay.example.com",
  );
  await expectReject(
    verifier,
    await sign({ consumer_id: "consumer-probe", sub: "" }),
    "empty subject is rejected",
    "sub empty",
  );
  await expectReject(
    verifier,
    await sign({ consumer_id: "" }),
    "empty consumer claim is rejected",
    "consumer_id empty",
  );
  await expectReject(
    verifier,
    await sign({ consumer_id: "consumer-probe", scope: [123] }),
    "malformed scope array is rejected",
    "scope [123]",
  );
  await expectReject(
    verifier,
    await sign({ consumer_id: "consumer-probe", exp: Math.floor(Date.now() / 1000) - 60 }),
    "expired token is rejected",
    "exp in the past",
  );

  // A token signed by a key that is not in the trusted JWKS must fail even with
  // perfect claims: signature trust comes from the key set only.
  const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const foreignSigned = await new SignJWT({
    iss: CLOUD_AUTH_TOKEN_ISSUER,
    aud: GUANLAN_SERVICE_AUDIENCE,
    sub: "account-probe",
    consumer_id: "consumer-probe",
    scope: [GUANLAN_REQUIRED_SCOPE],
    exp: Math.floor(Date.now() / 1000) + 300,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "gln014-probe-key" })
    .sign(other.privateKey);
  await expectReject(verifier, foreignSigned, "token signed by an unknown key is rejected", "signature not in trusted JWKS");

  const failures = results.filter(result => !result.ok);
  console.log(
    `\n${results.length - failures.length}/${results.length} contract expectations held.`,
  );
  if (failures.length > 0) {
    console.log("FAILED: " + failures.map(failure => failure.name).join("; "));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("probe crashed:", error);
  process.exitCode = 1;
});
