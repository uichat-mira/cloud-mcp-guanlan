import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

export const MCP_RESOURCE_PATH = "/mcp";
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const GUANLAN_INSTANCE_SERVICE_ID = "news";
export const GUANLAN_REQUIRED_SCOPE = "guanlan.read";
export const GUANLAN_WRITE_SCOPE = "guanlan.write";

export const hasWriteScope = (scopes: readonly string[]): boolean =>
  scopes.includes(GUANLAN_WRITE_SCOPE);

export const CLOUD_AUTH_TOKEN_ISSUER = "mira:cloud-auth";
export const GUANLAN_MCP_SERVER_NAME = "guanlan";
export const GUANLAN_MCP_SERVER_VERSION = "0.2.0-gln-015";

export type McpEnv = {
  MCP_RESOURCE_URL?: string;
  CLOUD_AUTH_ISSUER?: string;
  CLOUD_AUTH_JWKS_URL?: string;
  GUANLAN_APP_ID?: string;
};

export type McpConfig = {
  resourceUrl: URL;
  metadataUrl: string;
  /** OAuth authorization-server URL advertised in RFC 9728 discovery. */
  issuer: string;
  /** JWT issuer of Mira ID service credentials, distinct from its OAuth URL. */
  tokenIssuer: string;
  jwksUrl: URL;
  /** V1 access credentials bind aud/resource to the exact protected resource. */
  audience: string;
  requiredScopes: string[];
  appId: string;
  serviceId: string;
};

export type McpConfigResult =
  | { ok: true; config: McpConfig }
  | { ok: false; reason: string };

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

const secureUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && localHostnames.has(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
};

/**
 * Resolves the Mira ID V1 resource-server boundary from deployment bindings.
 * There is no configurable audience, scope policy or consumer-claim fallback:
 * the instance manifest and exact MCP resource are the only service identity.
 */
export function resolveMcpConfig(env: McpEnv): McpConfigResult {
  const rawResource = env.MCP_RESOURCE_URL?.trim() ?? "";
  const resourceUrl = secureUrl(rawResource);
  if (!resourceUrl) return { ok: false, reason: "mcp_resource_url" };
  if (resourceUrl.pathname !== MCP_RESOURCE_PATH) {
    return { ok: false, reason: "mcp_resource_path" };
  }
  if (
    resourceUrl.protocol !== "https:" ||
    resourceUrl.search ||
    resourceUrl.href !== rawResource
  ) {
    return { ok: false, reason: "mcp_resource_url" };
  }

  const issuer = env.CLOUD_AUTH_ISSUER?.trim() ?? "";
  if (!secureUrl(issuer)) return { ok: false, reason: "cloud_auth_issuer" };

  const jwksUrl = secureUrl(env.CLOUD_AUTH_JWKS_URL?.trim() ?? "");
  if (!jwksUrl) return { ok: false, reason: "cloud_auth_jwks_url" };

  const appId = env.GUANLAN_APP_ID?.trim() ?? "";
  if (!appIdPattern.test(appId)) {
    return { ok: false, reason: "application_id" };
  }

  return {
    ok: true,
    config: {
      resourceUrl,
      metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      issuer,
      tokenIssuer: CLOUD_AUTH_TOKEN_ISSUER,
      jwksUrl,
      audience: resourceUrl.href,
      requiredScopes: [GUANLAN_REQUIRED_SCOPE],
      appId,
      serviceId: GUANLAN_INSTANCE_SERVICE_ID,
    },
  };
}

export function buildMcpProtectedResourceMetadata(
  config: McpConfig,
): OAuthProtectedResourceMetadata {
  const metadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: { issuer: config.issuer } as OAuthMetadata,
    resourceServerUrl: config.resourceUrl,
    scopesSupported: [GUANLAN_REQUIRED_SCOPE, GUANLAN_WRITE_SCOPE],
    resourceName: "观澜 Guanlan",
    serviceDocumentationUrl: new URL("https://github.com/uichat-mira/cloud-mcp-guanlan"),
  });
  return {
    ...metadata,
    bearer_methods_supported: ["header"],
  };
}
