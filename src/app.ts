import { Hono } from "hono";
import {
  guanlanBrandAsset,
  renderGuanlanBrandPage,
  renderGuanlanHomePage,
} from "./brand";
import {
  APPLICATION_MANIFEST_PATH,
  APPLICATION_VERIFY_PATH,
  handleApplicationRequest,
  type ApplicationEnv,
} from "./application/instance";
import {
  APPLICATION_OAUTH_CALLBACK_PATH,
  APPLICATION_OAUTH_START_PATH,
  handleApplicationOAuthRequest,
} from "./application/oauth";
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
    c.html(renderGuanlanHomePage(), 200, {
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    }));

  app.get("/brand", c =>
    c.html(renderGuanlanBrandPage(), 200, {
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    }));

  app.get("/favicon.svg", c => {
    const asset = guanlanBrandAsset("guanlan-mark.svg")!;
    return c.body(asset.body, 200, {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  });

  app.get("/brand/:asset", c => {
    const asset = guanlanBrandAsset(c.req.param("asset"));
    if (!asset) return c.json({ error: "not_found" }, 404);
    return c.body(asset.body, 200, {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=86400",
      "content-disposition": `inline; filename="${asset.filename}"`,
      "x-content-type-options": "nosniff",
    });
  });

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

  app.all(APPLICATION_OAUTH_START_PATH, async c => {
    const response = await handleApplicationOAuthRequest(c.req.raw, c.env);
    return response ?? c.json({ error: "not_found" }, 404);
  });
  app.all(APPLICATION_OAUTH_CALLBACK_PATH, async c => {
    const response = await handleApplicationOAuthRequest(c.req.raw, c.env);
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
