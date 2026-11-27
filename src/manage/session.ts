import { resolveApplicationInstance, type ApplicationEnv } from "../application/instance";
import type { GuanlanPrincipal } from "../mcp/auth";
import { subjectFromPrincipal } from "../subscriptions";

export const MANAGEMENT_PATH = "/manage";
export const MANAGEMENT_SUBSCRIPTIONS_PATH = "/manage/subscriptions";
export const MANAGEMENT_LOGOUT_PATH = "/manage/logout";
export const MANAGEMENT_SESSION_COOKIE = "__Host-guanlan_manage";
export const MANAGEMENT_SESSION_TTL_SECONDS = 15 * 60;
export const GUANLAN_MANAGE_SCOPE = "guanlan.manage";

const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const SESSION_VALUE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type ManagementSessionEnv = ApplicationEnv & {
  GUANLAN_WEB_SESSION_SECRET?: string;
};

export type ConfirmedApplicationIdentity = {
  readonly issuer: "mira:cloud-auth";
  readonly subject: string;
  readonly audience: string;
  readonly appId: string;
  readonly expiresAt: string;
};

export type ManagementAuthority = "account" | "consumer";

type SessionClaims = {
  readonly v: 1;
  readonly sub: string;
  readonly iss: "mira:cloud-auth";
  readonly aud: string;
  readonly appId: string;
  readonly iat: number;
  readonly exp: number;
  readonly authorities: readonly ["account", "consumer"];
};

export type ManagementSession =
  | {
      readonly ok: true;
      readonly principal: GuanlanPrincipal;
      readonly authorities: readonly ManagementAuthority[];
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly failure: "not_configured" | "missing" | "invalid" | "expired";
    };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(secret),
    new TextEncoder().encode(payload),
  );
  return base64url(new Uint8Array(signature));
}

async function verifyPayload(secret: string, payload: string, signature: string): Promise<boolean> {
  const decoded = decodeBase64url(signature);
  if (!decoded) return false;
  return crypto.subtle.verify(
    "HMAC",
    await importSigningKey(secret),
    decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer,
    new TextEncoder().encode(payload),
  );
}

function sessionCookie(value: string, maxAge: number): string {
  return [
    `${MANAGEMENT_SESSION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, maxAge)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function clearManagementSessionCookie(headers: Headers): void {
  headers.append("set-cookie", sessionCookie("", 0));
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

function resolveSecret(env: ManagementSessionEnv): string | null {
  const secret = env.GUANLAN_WEB_SESSION_SECRET;
  return typeof secret === "string" && SESSION_SECRET_PATTERN.test(secret) ? secret : null;
}

const SESSION_CLAIM_KEYS = new Set([
  "appId",
  "aud",
  "authorities",
  "exp",
  "iat",
  "iss",
  "sub",
  "v",
]);

function parseClaims(value: unknown): SessionClaims | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== SESSION_CLAIM_KEYS.size ||
    keys.some(key => !SESSION_CLAIM_KEYS.has(key)) ||
    candidate.v !== 1 ||
    candidate.iss !== "mira:cloud-auth" ||
    typeof candidate.sub !== "string" ||
    typeof candidate.aud !== "string" ||
    typeof candidate.appId !== "string" ||
    typeof candidate.iat !== "number" ||
    !Number.isInteger(candidate.iat) ||
    typeof candidate.exp !== "number" ||
    !Number.isInteger(candidate.exp) ||
    !Array.isArray(candidate.authorities) ||
    candidate.authorities.length !== 2 ||
    candidate.authorities[0] !== "account" ||
    candidate.authorities[1] !== "consumer"
  ) {
    return null;
  }
  return candidate as unknown as SessionClaims;
}

export async function issueManagementSessionCookie(
  headers: Headers,
  identity: ConfirmedApplicationIdentity,
  env: ManagementSessionEnv,
  now = Date.now(),
): Promise<boolean> {
  const secret = resolveSecret(env);
  const instance = resolveApplicationInstance(env);
  if (!secret || !instance) return false;
  if (
    identity.issuer !== "mira:cloud-auth" ||
    identity.audience !== instance.clientId ||
    identity.appId !== instance.appId
  ) {
    return false;
  }

  const identityExpiry = Date.parse(identity.expiresAt);
  if (!Number.isFinite(identityExpiry) || identityExpiry <= now) return false;

  const iat = Math.floor(now / 1000);
  const exp = Math.floor(Math.min(
    identityExpiry,
    now + MANAGEMENT_SESSION_TTL_SECONDS * 1000,
  ) / 1000);
  if (exp <= iat) return false;

  const principal: GuanlanPrincipal = {
    accountId: identity.subject,
    consumerId: identity.subject,
    scopes: [GUANLAN_MANAGE_SCOPE],
    expiresAt: exp,
    issuer: identity.issuer,
    audience: identity.audience,
  };
  try {
    subjectFromPrincipal(principal);
  } catch {
    return false;
  }

  const claims: SessionClaims = {
    v: 1,
    sub: identity.subject,
    iss: identity.issuer,
    aud: identity.audience,
    appId: identity.appId,
    iat,
    exp,
    authorities: ["account", "consumer"],
  };
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await signPayload(secret, encoded);
  headers.append("set-cookie", sessionCookie(`${encoded}.${signature}`, exp - iat));
  return true;
}

export async function readManagementSession(
  request: Request,
  env: ManagementSessionEnv,
  now = Date.now(),
): Promise<ManagementSession> {
  const secret = resolveSecret(env);
  const instance = resolveApplicationInstance(env);
  if (!secret || !instance) return { ok: false, failure: "not_configured" };

  const raw = readUniqueCookie(request, MANAGEMENT_SESSION_COOKIE);
  if (!raw) return { ok: false, failure: "missing" };
  if (!SESSION_VALUE_PATTERN.test(raw)) return { ok: false, failure: "invalid" };

  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !(await verifyPayload(secret, payload, signature))) {
    return { ok: false, failure: "invalid" };
  }

  const decoded = decodeBase64url(payload);
  if (!decoded) return { ok: false, failure: "invalid" };

  let claims: SessionClaims | null = null;
  try {
    claims = parseClaims(JSON.parse(new TextDecoder().decode(decoded)));
  } catch {
    claims = null;
  }
  if (!claims) return { ok: false, failure: "invalid" };

  const nowSeconds = Math.floor(now / 1000);
  if (
    claims.exp <= nowSeconds ||
    claims.iat > nowSeconds + 5 ||
    claims.exp - claims.iat > MANAGEMENT_SESSION_TTL_SECONDS
  ) {
    return { ok: false, failure: "expired" };
  }
  if (
    claims.appId !== instance.appId ||
    claims.aud !== instance.clientId ||
    claims.iss !== "mira:cloud-auth"
  ) {
    return { ok: false, failure: "invalid" };
  }

  const principal: GuanlanPrincipal = {
    accountId: claims.sub,
    consumerId: claims.sub,
    scopes: [GUANLAN_MANAGE_SCOPE],
    expiresAt: claims.exp,
    issuer: claims.iss,
    audience: claims.aud,
  };
  try {
    subjectFromPrincipal(principal);
  } catch {
    return { ok: false, failure: "invalid" };
  }

  return {
    ok: true,
    principal,
    authorities: [...claims.authorities],
    expiresAt: claims.exp,
  };
}
