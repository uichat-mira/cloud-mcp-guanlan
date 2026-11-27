import type { GuanlanPrincipal } from "../src/mcp/auth";

export const MCP_TEST_RESOURCE_URL = "https://127.0.0.1/mcp";
export const MCP_TEST_ISSUER = "https://auth.example.com";
export const MCP_TEST_TOKEN_ISSUER = "mira:cloud-auth";
export const MCP_TEST_JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
export const MCP_TEST_AUDIENCE = MCP_TEST_RESOURCE_URL;
export const MCP_TEST_APP_ID = "guanlan.test.instance";
export const MCP_TEST_SERVICE_ID = "news";
export const MCP_TEST_SCOPE = "guanlan.read";
export const MCP_TEST_WRITE_SCOPE = "guanlan.write";
export const MCP_TEST_FUTURE_EXP = 4_102_444_800;

const base = (): GuanlanPrincipal => ({
  accountId: "account-a",
  consumerId: "account-a",
  scopes: [MCP_TEST_SCOPE],
  expiresAt: MCP_TEST_FUTURE_EXP,
  issuer: MCP_TEST_TOKEN_ISSUER,
  audience: MCP_TEST_AUDIENCE,
});

const readWrite = (): GuanlanPrincipal => ({
  ...base(),
  scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE],
});

export const FIXTURE_TOKENS: Record<string, GuanlanPrincipal> = {
  "fixture-consumer-1": base(),
  "fixture-consumer-2": { ...base(), accountId: "account-c", consumerId: "account-c" },
  "fixture-account-b": { ...base(), accountId: "account-b", consumerId: "account-b" },
  "fixture-unprovisioned": { ...base(), accountId: "account-z", consumerId: "account-z" },
  "fixture-empty-account": { ...base(), accountId: "account-empty", consumerId: "account-empty" },
  "fixture-writer-1": readWrite(),
  "fixture-writer-2": {
    ...readWrite(),
    accountId: "account-c",
    consumerId: "account-c",
  },
  "fixture-writer-account-b": {
    ...readWrite(),
    accountId: "account-b",
    consumerId: "account-b",
  },
  "fixture-writer-unprovisioned": {
    ...readWrite(),
    accountId: "account-z",
    consumerId: "account-z",
  },
  "fixture-writer-empty": {
    ...readWrite(),
    accountId: "account-empty",
    consumerId: "account-empty",
  },
  "fixture-wrong-issuer": { ...base(), issuer: "mira:other-issuer" },
  "fixture-shiyan-audience": { ...base(), audience: "https://api.shiyan.example.com/mcp" },
  "fixture-relay-audience": { ...base(), audience: "https://api.relay.example.com/mcp" },
  "fixture-wrong-scope": { ...base(), scopes: ["news.write"] },
  "fixture-expired": { ...base(), expiresAt: 1 },
  "fixture-missing-consumer": { ...base(), consumerId: "" },
};
