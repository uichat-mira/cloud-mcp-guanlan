import { Hono } from "hono";
import {
  APPLICATION_MANIFEST_PATH,
  APPLICATION_VERIFY_PATH,
  handleApplicationRequest,
  type ApplicationEnv,
} from "./application/instance";
import type { PocEnv } from "./ingest";
import { MCP_METADATA_PATH, MCP_RESOURCE_PATH, type McpEnv } from "./mcp/config";
import {
  createMcpRuntime,
  type McpRuntimeOptions,
  type McpRuntimeResult,
} from "./mcp/runtime";

export type GuanlanEnv = PocEnv & McpEnv & ApplicationEnv;
export type McpRuntimeResolver = (env: GuanlanEnv) => McpRuntimeResult;

export function createApp(
  options: {
    resolveMcpRuntime?: McpRuntimeResolver;
    mcpRuntimeOptions?: McpRuntimeOptions;
  } = {},
) {
  const resolveMcpRuntime =
    options.resolveMcpRuntime ??
    ((env: GuanlanEnv) => createMcpRuntime(env, options.mcpRuntimeOptions));
  const app = new Hono<{ Bindings: GuanlanEnv }>();

  app.get("/", c =>
    c.html(
      `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>观澜 Guanlan</title>
  <meta name="description" content="Mira Cloud 的持续信息采集与消费记忆服务。">
  <style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ef;color:#171b25}
    main{width:min(680px,calc(100% - 48px));padding:72px 0}
    .mark{font:500 14px/1.2 ui-serif,Georgia,serif;letter-spacing:.16em;opacity:.56}
    h1{margin:18px 0 18px;font:500 clamp(42px,9vw,76px)/.95 ui-serif,Georgia,serif;letter-spacing:-.04em}
    p{max-width:560px;margin:0;font-size:17px;line-height:1.8;opacity:.7}
    @media(prefers-color-scheme:dark){body{background:#151a2c;color:#fff6ed}}
  </style>
</head>
<body><main><div class="mark">MIRA CLOUD</div><h1>观澜<br>Guanlan</h1><p>持续采集值得看见的信息，保留每一次阅读与决策的上下文。理解与选择，仍交给你的 Agent。</p></main></body>
</html>`,
      200,
      {
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    ));

  app.get("/health", c =>
    c.json({
      service: "guanlan",
      product: "观澜 Guanlan",
      status: "ok",
      publicApi: false,
    }));

  app.all(APPLICATION_MANIFEST_PATH, async c => {
    const response = await handleApplicationRequest(c.req.raw, c.env);
    return response ?? c.json({ error: "not_found" }, 404);
  });
  app.all(APPLICATION_VERIFY_PATH, async c => {
    const response = await handleApplicationRequest(c.req.raw, c.env);
    return response ?? c.json({ error: "not_found" }, 404);
  });

  // The only agent-facing HTTP surface. Missing Mira ID V1 trust stays closed.
  app.all(MCP_RESOURCE_PATH, c => {
    const resolved = resolveMcpRuntime(c.env);
    if (!resolved.ok) {
      return c.json(
        { error: "mcp_not_configured", reason: resolved.reason },
        503,
      );
    }
    return resolved.runtime.fetch(c.req.raw);
  });
  app.all(MCP_METADATA_PATH, c => {
    const resolved = resolveMcpRuntime(c.env);
    if (!resolved.ok) {
      return c.json(
        { error: "mcp_not_configured", reason: resolved.reason },
        503,
      );
    }
    return resolved.runtime.fetch(c.req.raw);
  });

  // No parallel agent REST API and no retired HMAC registration side channel.
  app.notFound(c => c.json({ error: "not_found" }, 404));

  return app;
}
