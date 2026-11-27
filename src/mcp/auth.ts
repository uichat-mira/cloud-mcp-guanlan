import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GUANLAN_REQUIRED_SCOPE, GUANLAN_WRITE_SCOPE } from "./config";

export type GuanlanPrincipal = {
  /** Mira ID subject; the Cloud Account that owns this Guanlan data. */
  accountId: string;
  /** V1 uses the verified account subject as the stable Guanlan consumer. */
  consumerId: string;
  scopes: string[];
  expiresAt: number;
  issuer: string;
  audience: string;
};

export interface GuanlanTokenVerifier {
  verifyAccessToken(token: string): Promise<GuanlanPrincipal>;
}

export type CloudAuthVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  appId: string;
  serviceId: string;
  /** Test/integration injection point; production uses the configured remote JWKS. */
  keySet?: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
};

const invalidToken = (): OAuthError =>
  new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");

const claimKeys = new Set([
  "iss",
  "sub",
  "device_id",
  "aud",
  "app_id",
  "service_id",
  "resource",
  "scope",
  "iat",
  "nbf",
  "exp",
]);

const allowedScopes = new Set([GUANLAN_REQUIRED_SCOPE, GUANLAN_WRITE_SCOPE]);

/**
 * Verify exactly one Mira ID V1 instance/resource credential.
 *
 * Account and consumer identity are derived from the verified subject; callers
 * cannot choose another consumer through JWT extension claims or tool input.
 */
export function createCloudAuthVerifier(
  options: CloudAuthVerifierOptions,
): GuanlanTokenVerifier {
  const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);

  return {
    async verifyAccessToken(token: string): Promise<GuanlanPrincipal> {
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["EdDSA"],
          clockTolerance: options.clockToleranceSeconds ?? 0,
          requiredClaims: [...claimKeys],
        });
        payload = verified.payload as Record<string, unknown>;
      } catch {
        throw invalidToken();
      }

      const now = Math.floor(Date.now() / 1000);
      const scopes = payload.scope;
      if (
        Object.keys(payload).some(key => !claimKeys.has(key)) ||
        payload.aud !== options.audience ||
        payload.resource !== options.audience ||
        payload.app_id !== options.appId ||
        payload.service_id !== options.serviceId ||
        typeof payload.sub !== "string" ||
        !payload.sub.trim() ||
        typeof payload.device_id !== "string" ||
        !payload.device_id.trim() ||
        typeof payload.iat !== "number" ||
        !Number.isSafeInteger(payload.iat) ||
        typeof payload.nbf !== "number" ||
        !Number.isSafeInteger(payload.nbf) ||
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat > now ||
        payload.nbf < payload.iat ||
        payload.nbf > now ||
        payload.exp <= now ||
        payload.exp <= payload.nbf ||
        payload.exp - payload.iat > 600 ||
        !Array.isArray(scopes) ||
        scopes.length < 1 ||
        scopes.length > 2 ||
        !scopes.every(scope => typeof scope === "string" && allowedScopes.has(scope)) ||
        new Set(scopes).size !== scopes.length ||
        !scopes.includes(GUANLAN_REQUIRED_SCOPE)
      ) {
        throw invalidToken();
      }

      return {
        accountId: payload.sub,
        consumerId: payload.sub,
        scopes: [...scopes] as string[],
        expiresAt: payload.exp,
        issuer: options.issuer,
        audience: options.audience,
      };
    },
  };
}

export type FixtureTokenTable = Record<string, GuanlanPrincipal>;

export function createFixtureVerifier(
  tokens: FixtureTokenTable,
  expected: { issuer: string; audience: string },
): GuanlanTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<GuanlanPrincipal> {
      const principal = tokens[token];
      if (!principal) throw invalidToken();
      if (
        principal.issuer !== expected.issuer ||
        principal.audience !== expected.audience ||
        !principal.accountId ||
        !principal.consumerId ||
        !principal.scopes.includes(GUANLAN_REQUIRED_SCOPE)
      ) {
        throw invalidToken();
      }
      return { ...principal, scopes: [...principal.scopes] };
    },
  };
}

export function authInfoFromPrincipal(
  token: string,
  principal: GuanlanPrincipal,
  resourceUrl: URL,
): AuthInfo {
  return {
    token,
    clientId: principal.consumerId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource: resourceUrl,
    extra: {
      accountId: principal.accountId,
      consumerId: principal.consumerId,
      issuer: principal.issuer,
      audience: principal.audience,
    },
  };
}

export function principalFromAuthInfo(
  authInfo: AuthInfo | undefined,
): GuanlanPrincipal {
  const extra = authInfo?.extra;
  const accountId = extra?.accountId;
  const consumerId = extra?.consumerId;
  const issuer = extra?.issuer;
  const audience = extra?.audience;
  if (
    !authInfo ||
    typeof accountId !== "string" ||
    typeof consumerId !== "string" ||
    typeof issuer !== "string" ||
    typeof audience !== "string" ||
    !Array.isArray(authInfo.scopes) ||
    typeof authInfo.expiresAt !== "number"
  ) {
    throw invalidToken();
  }

  return {
    accountId,
    consumerId,
    scopes: [...authInfo.scopes],
    expiresAt: authInfo.expiresAt,
    issuer,
    audience,
  };
}
