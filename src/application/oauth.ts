import { z } from "zod";
import { renderGuanlanResultPage } from "../brand";
import {
  issueManagementSessionCookie,
  type ManagementSessionEnv,
} from "../manage/session";
import {
  resolveApplicationInstance,
  type ApplicationEnv,
} from "./instance";

export const APPLICATION_OAUTH_START_PATH = "/auth/start";
export const APPLICATION_OAUTH_CALLBACK_PATH = "/auth/callback";

const STATE_COOKIE = "__Host-guanlan_oauth_state";
const VERIFIER_COOKIE = "__Host-guanlan_oauth_verifier";
const FLOW_TTL_SECONDS = 300;

export type ApplicationOAuthEnv = ApplicationEnv & ManagementSessionEnv & {
  CLOUD_AUTH_ISSUER?: string;
};

export type ApplicationOAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const tokenSchema = z.object({
  access_token: z.string().regex(/^mas_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(3600),
  expiresAt: z.iso.datetime(),
  issuer: z.literal("mira:cloud-auth"),
  subject: z.string().min(1),
  audience: z.string().min(1).max(2048),
  appId: z.string().min(1).max(160),
}).strict();

const identitySchema = tokenSchema.pick({
  expiresAt: true,
  issuer: true,
  subject: true,
  audience: true,
  appId: true,
}).strict();

const authorizationCodePattern = /^mca_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const statePattern = /^[A-Za-z0-9._~-]{16,512}$/;
const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;

type OAuthConfig = {
  instance: NonNullable<ReturnType<typeof resolveApplicationInstance>>;
  base: string;
};

export function resolveApplicationOAuthConfig(
  env: ApplicationOAuthEnv,
): OAuthConfig | null {
  const instance = resolveApplicationInstance(env);
  if (!instance) return null;

  let issuer: URL;
  try {
    issuer = new URL(env.CLOUD_AUTH_ISSUER ?? "");
  } catch {
    return null;
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash
  ) {
    return null;
  }
  return { instance, base: issuer.origin };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomValue(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return base64url(digest);
}

function securityHeaders(contentType = "text/html; charset=utf-8"): Headers {
  return new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-type": contentType,
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function flowCookie(name: string, value: string, maxAge: number): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function addFlowCookies(headers: Headers, state: string, verifier: string): void {
  headers.append("set-cookie", flowCookie(STATE_COOKIE, state, FLOW_TTL_SECONDS));
  headers.append("set-cookie", flowCookie(VERIFIER_COOKIE, verifier, FLOW_TTL_SECONDS));
}

function clearFlowCookies(headers: Headers): void {
  headers.append("set-cookie", flowCookie(STATE_COOKIE, "", 0));
  headers.append("set-cookie", flowCookie(VERIFIER_COOKIE, "", 0));
}

function readUniqueCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  const values = raw
    .split(";")
    .map(part => part.trim())
    .filter(part => part.startsWith(name + "="))
    .map(part => part.slice(name.length + 1));
  return values.length === 1 ? values[0]! : null;
}

function hasStrictQuery(
  url: URL,
  allowed: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  let valid = true;
  url.searchParams.forEach((_value, key) => {
    if (!allowed.has(key) || seen.has(key)) valid = false;
    seen.add(key);
  });
  return valid;
}

function redirect(location: string, headers = securityHeaders("text/plain; charset=utf-8")): Response {
  headers.set("location", location);
  return new Response(null, { status: 302, headers });
}

function resultPage(
  status: number,
  kind: "success" | "error",
  title: string,
  message: string,
  detail: string,
  headers = securityHeaders(),
  action?: { href: "/" | "/auth/start" | "/manage"; label: string },
): Response {
  const html = renderGuanlanResultPage({
    kind,
    title,
    message,
    detail,
    actionHref: action?.href ?? (kind === "success" ? "/" : "/auth/start"),
    actionLabel: action?.label ?? (kind === "success" ? "返回观澜" : "重新连接"),
  });
  return new Response(html, { status, headers });
}

function failed(
  status: number,
  code: string,
  message: string,
  headers?: Headers,
): Response {
  return resultPage(status, "error", "连接未完成", message, code, headers);
}

function tokenIdentityMatches(
  value: z.infer<typeof tokenSchema>,
  config: OAuthConfig,
): boolean {
  const expiry = Date.parse(value.expiresAt);
  const now = Date.now();
  return (
    value.audience === config.instance.clientId &&
    value.appId === config.instance.appId &&
    Number.isFinite(expiry) &&
    expiry > now &&
    expiry <= now + 3_605_000
  );
}

export async function handleApplicationOAuthRequest(
  request: Request,
  env: ApplicationOAuthEnv,
  fetchFn: ApplicationOAuthFetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== APPLICATION_OAUTH_START_PATH &&
    url.pathname !== APPLICATION_OAUTH_CALLBACK_PATH
  ) {
    return null;
  }

  const config = resolveApplicationOAuthConfig(env);
  if (!config) {
    return failed(503, "oauth_not_configured", "观澜暂时无法连接 Mira ID。");
  }
  if (url.origin !== config.instance.origin) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: securityHeaders("application/json; charset=utf-8"),
    });
  }
  if (request.method !== "GET") {
    return failed(405, "method_not_allowed", "此入口只接受浏览器 GET 请求。");
  }

  if (url.pathname === APPLICATION_OAUTH_START_PATH) {
    if (url.search !== "") {
      return failed(400, "unexpected_parameter", "连接请求包含无法识别的参数。");
    }
    const state = randomValue(32);
    const verifier = randomValue(32);
    const challenge = await pkceChallenge(verifier);
    const authorize = new URL("/v1/oauth/authorize", config.base);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: config.instance.clientId,
      redirect_uri: config.instance.callback,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const headers = securityHeaders("text/plain; charset=utf-8");
    addFlowCookies(headers, state, verifier);
    return redirect(authorize.href, headers);
  }

  const headers = securityHeaders();
  const state = readUniqueCookie(request, STATE_COOKIE);
  const verifier = readUniqueCookie(request, VERIFIER_COOKIE);
  clearFlowCookies(headers);

  if (
    !hasStrictQuery(url, new Set(["code", "state", "error"])) ||
    !state ||
    !statePattern.test(state) ||
    !verifier ||
    !verifierPattern.test(verifier) ||
    url.searchParams.get("state") !== state
  ) {
    return failed(400, "invalid_state", "授权回调与当前浏览器发起的连接不匹配。", headers);
  }

  if (url.searchParams.has("error")) {
    return failed(400, "authorization_not_completed", "Mira ID 没有完成这次授权。", headers);
  }

  const code = url.searchParams.get("code");
  if (!code || !authorizationCodePattern.test(code)) {
    return failed(400, "invalid_authorization_code", "授权码缺失或格式无效。", headers);
  }

  try {
    const tokenResponse = await fetchFn(new URL("/v1/oauth/token", config.base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.instance.clientId,
        redirect_uri: config.instance.callback,
        code,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      return failed(401, "authorization_code_rejected", "Mira ID 拒绝了这次授权兑换。", headers);
    }

    const parsed = tokenSchema.safeParse(await tokenResponse.json());
    if (!parsed.success || !tokenIdentityMatches(parsed.data, config)) {
      return failed(502, "invalid_application_session", "Mira ID 返回的应用会话未通过观澜校验。", headers);
    }

    const sessionResponse = await fetchFn(
      new URL("/v1/oauth/application-session", config.base),
      {
        method: "GET",
        headers: { authorization: `Bearer ${parsed.data.access_token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!sessionResponse.ok) {
      return failed(502, "application_session_unconfirmed", "Mira ID 未能确认刚建立的应用会话。", headers);
    }

    const identity = identitySchema.safeParse(await sessionResponse.json());
    if (
      !identity.success ||
      identity.data.issuer !== parsed.data.issuer ||
      identity.data.subject !== parsed.data.subject ||
      identity.data.audience !== parsed.data.audience ||
      identity.data.appId !== parsed.data.appId ||
      identity.data.expiresAt !== parsed.data.expiresAt
    ) {
      return failed(502, "application_session_mismatch", "Mira ID 会话确认结果与授权兑换不一致。", headers);
    }

    const managementReady = await issueManagementSessionCookie(
      headers,
      identity.data,
      env,
    );

    return resultPage(
      200,
      "success",
      "观澜已连接",
      managementReady
        ? "Mira ID 已建立观澜的应用授权，并为当前浏览器建立短时管理会话。"
        : "Mira ID 已建立观澜的应用授权与服务关联。你的 Mira 终端现在可以发现观澜新闻服务。",
      managementReady
        ? "临时 Mira ID access token 未持久化；管理会话仅保存签名后的账户主体与短时权限。"
        : "授权完成；临时应用 access token 未写入 Cookie、D1 或浏览器存储。",
      headers,
      managementReady ? { href: "/manage", label: "打开管理界面" } : undefined,
    );
  } catch {
    return failed(502, "cloud_auth_unavailable", "当前无法完成 Mira ID 会话确认。", headers);
  }
}
