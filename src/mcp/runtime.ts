import { createCloudAuthVerifier, type GuanlanTokenVerifier } from "./auth";
import { resolveMcpConfig, type McpEnv } from "./config";
import { createGuanlanMcp, type GuanlanMcpRuntime } from "./server";
import {
  createD1NewsDecider,
  createD1NewsReader,
  type GuanlanNewsDecider,
  type GuanlanNewsReader,
} from "./service";

export type McpRuntimeEnv = McpEnv & { DB: D1Database };

export type McpRuntimeOptions = {
  /** Test-only injection; the deployed entry never supplies this. */
  verifier?: GuanlanTokenVerifier;
  reader?: GuanlanNewsReader;
  decider?: GuanlanNewsDecider;
};

export type McpRuntimeResult =
  | { ok: true; runtime: GuanlanMcpRuntime }
  | { ok: false; reason: string };

const cache = new WeakMap<D1Database, Map<string, McpRuntimeResult>>();

export function createMcpRuntime(
  env: McpRuntimeEnv,
  options: McpRuntimeOptions = {},
): McpRuntimeResult {
  const resolved = resolveMcpConfig(env);
  if (!resolved.ok) return resolved;

  const { config } = resolved;
  const verifierOf = () =>
    createCloudAuthVerifier({
      issuer: config.tokenIssuer,
      audience: config.audience,
      jwksUrl: config.jwksUrl,
      appId: config.appId,
      serviceId: config.serviceId,
    });

  if (options.verifier || options.reader || options.decider) {
    const verifier = options.verifier ?? verifierOf();
    const reader = options.reader ?? createD1NewsReader(env.DB);
    const decider = options.decider ?? createD1NewsDecider(env.DB);
    return {
      ok: true,
      runtime: createGuanlanMcp(config, verifier, reader, decider),
    };
  }

  const key = [
    config.resourceUrl.href,
    config.issuer,
    config.tokenIssuer,
    config.jwksUrl.href,
    config.appId,
    config.serviceId,
  ].join("\n");
  let byKey = cache.get(env.DB);
  if (!byKey) {
    byKey = new Map();
    cache.set(env.DB, byKey);
  }
  const existing = byKey.get(key);
  if (existing) return existing;

  const result: McpRuntimeResult = {
    ok: true,
    runtime: createGuanlanMcp(
      config,
      verifierOf(),
      createD1NewsReader(env.DB),
      createD1NewsDecider(env.DB),
    ),
  };
  byKey.set(key, result);
  return result;
}
