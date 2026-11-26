import {
  DECIDE_TOOL_NAME,
  NEWS_TOOL_NAME,
  WHOAMI_TOOL_NAME,
} from "../mcp/capabilities";
import {
  GUANLAN_INSTANCE_SERVICE_ID,
  GUANLAN_REQUIRED_SCOPE,
  GUANLAN_WRITE_SCOPE,
} from "../mcp/config";

export const APPLICATION_MANIFEST_PATH = "/.well-known/mira-application";
export const APPLICATION_VERIFY_PATH = "/mira/verify-registration";

export type ApplicationEnv = {
  GUANLAN_APP_ID?: string;
  GUANLAN_APP_SECRET?: string;
  GUANLAN_MANIFEST_REVISION?: string;
  MCP_RESOURCE_URL?: string;
};

const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

export function resolveApplicationInstance(env: ApplicationEnv) {
  const appId = env.GUANLAN_APP_ID;
  const secret = env.GUANLAN_APP_SECRET;
  const revision = Number(env.GUANLAN_MANIFEST_REVISION);
  let resource: URL;
  try {
    resource = new URL(env.MCP_RESOURCE_URL ?? "");
  } catch {
    return null;
  }
  if (
    !appId ||
    !appIdPattern.test(appId) ||
    !secret ||
    secret.length < 16 ||
    secret.length > 512 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    resource.protocol !== "https:" ||
    resource.pathname !== "/mcp" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    resource.href !== env.MCP_RESOURCE_URL
  ) {
    return null;
  }

  const origin = resource.origin;
  return {
    appId,
    origin,
    resource: resource.href,
    revision,
    clientId: origin + "/oauth-client",
    callback: origin + "/auth/callback",
  };
}

export function applicationManifest(
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>,
) {
  return {
    schemaVersion: "1",
    appId: instance.appId,
    projectId: "guanlan",
    name: "观澜 Guanlan",
    homeUrl: instance.origin + "/",
    manifestRevision: instance.revision,
    oauth: {
      clientId: instance.clientId,
      redirectUris: [instance.callback],
    },
    registrationVerification: {
      endpoint: instance.origin + APPLICATION_VERIFY_PATH,
    },
    services: [
      {
        serviceId: GUANLAN_INSTANCE_SERVICE_ID,
        name: "观澜新闻服务",
        type: "mcp",
        protocol: {
          name: "mcp",
          version: "2026-07-28",
          endpoint: instance.resource,
        },
        resource: instance.resource,
        scopes: [GUANLAN_REQUIRED_SCOPE, GUANLAN_WRITE_SCOPE],
        capabilities: [
          {
            id: "guanlan.identity",
            title: "调用身份",
            description: "读取当前 Mira ID 已验证账号与本次服务凭据权限。",
            toolRefs: [WHOAMI_TOOL_NAME],
            selectionWeightHint: 0.1,
          },
          {
            id: "guanlan.news.read",
            title: "新闻读取",
            description: "读取当前账号可见的新闻候选、分页与消费状态。",
            toolRefs: [NEWS_TOOL_NAME],
            selectionWeightHint: 1,
          },
          {
            id: "guanlan.news.consume",
            title: "消费记忆",
            description: "把采用、忽略或待决结果写回当前账号的云端消费账本。",
            toolRefs: [DECIDE_TOOL_NAME],
            selectionWeightHint: 0.8,
          },
        ],
        toolGovernance: [
          {
            toolRef: WHOAMI_TOOL_NAME,
            riskHints: ["sensitive-data-read"],
          },
          {
            toolRef: NEWS_TOOL_NAME,
            riskHints: ["sensitive-data-read"],
          },
        ],
      },
    ],
  };
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const denied = (): Response => json({ error: "registration_rejected" }, 403);

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all(
    [actual, expected].map(async value =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function handleApplicationRequest(
  request: Request,
  env: ApplicationEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== APPLICATION_MANIFEST_PATH &&
    url.pathname !== APPLICATION_VERIFY_PATH
  ) {
    return null;
  }

  const instance = resolveApplicationInstance(env);
  if (!instance) return json({ error: "application_not_configured" }, 503);
  if (url.origin !== instance.origin || url.search) {
    return json({ error: "not_found" }, 404);
  }

  if (url.pathname === APPLICATION_MANIFEST_PATH) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return json(applicationManifest(instance));
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (
    request.headers.has("origin") ||
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
  ) {
    return denied();
  }

  const input = await boundedJson(request);
  if (!input || typeof input !== "object" || Array.isArray(input)) return denied();
  const fields = input as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    fields.appId !== instance.appId ||
    typeof fields.appSecret !== "string" ||
    fields.appSecret.length < 16 ||
    fields.appSecret.length > 512 ||
    !await equalSecret(fields.appSecret, env.GUANLAN_APP_SECRET!)
  ) {
    return denied();
  }

  return json({ ok: true, appId: instance.appId });
}
