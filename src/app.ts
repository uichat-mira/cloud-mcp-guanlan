import { Hono } from "hono";
import type { PocEnv } from "./ingest";
import { MCP_METADATA_PATH, MCP_RESOURCE_PATH, type McpEnv } from "./mcp/config";
import {
  createMcpRuntime,
  type McpRuntimeOptions,
  type McpRuntimeResult,
} from "./mcp/runtime";
import { handleRegistration, REGISTRATION_PATH, type RegistrationEnv } from "./registration";

export type GuanlanEnv = PocEnv & McpEnv & RegistrationEnv;
export type McpRuntimeResolver = (env: GuanlanEnv) => McpRuntimeResult;

export function createApp(options: {
  resolveMcpRuntime?: McpRuntimeResolver;
  mcpRuntimeOptions?: McpRuntimeOptions;
} = {}) {
  const resolveMcpRuntime = options.resolveMcpRuntime ??
    ((env: GuanlanEnv) => createMcpRuntime(env, options.mcpRuntimeOptions));
  const app = new Hono<{ Bindings: GuanlanEnv }>();

  app.get("/health", c => c.json({ service: "cloud-guanlan-poc", status: "ok", publicApi: false }));

  // Cloud Auth → Guanlan account-space registration (GLN-015). HMAC-authenticated
  // service traffic only: it is not part of the agent-facing MCP surface and
  // grants no access to subscriptions, interests or news state.
  app.all(REGISTRATION_PATH, c => handleRegistration(c.req.raw, c.env));

  // The only agent-facing HTTP surface. Unconfigured trust is a closed door,
  // not an anonymous fallback.
  app.all(MCP_RESOURCE_PATH, c => {
    const resolved = resolveMcpRuntime(c.env);
    if (!resolved.ok) return c.json({ error: "mcp_not_configured", reason: resolved.reason }, 503);
    return resolved.runtime.fetch(c.req.raw);
  });
  app.all(MCP_METADATA_PATH, c => {
    const resolved = resolveMcpRuntime(c.env);
    if (!resolved.ok) return c.json({ error: "mcp_not_configured", reason: resolved.reason }, 503);
    return resolved.runtime.fetch(c.req.raw);
  });

  // Deliberately no public news read/write REST endpoints. REST may later exist
  // as documented UI/management support, never as a parallel Agent API.
  app.notFound(c => c.json({ error: "not_found" }, 404));

  return app;
}
