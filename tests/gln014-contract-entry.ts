/**
 * GLN-014 reconnaissance entry. It re-exports the *existing* deployed resource
 * verifier and configuration resolver so a read-only probe can exercise the
 * real contract instead of a re-implementation. No production module changes.
 */
export { createCloudAuthVerifier } from "../src/mcp/auth";
export {
  CLOUD_AUTH_TOKEN_ISSUER,
  GUANLAN_REQUIRED_SCOPE,
  GUANLAN_SERVICE_AUDIENCE,
  GUANLAN_WRITE_SCOPE,
  resolveMcpConfig,
} from "../src/mcp/config";
