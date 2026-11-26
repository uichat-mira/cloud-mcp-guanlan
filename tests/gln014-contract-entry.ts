/**
 * GLN-014/V1 contract entry. It re-exports the real resource verifier and
 * configuration resolver for read-only cross-service probes.
 */
export { createCloudAuthVerifier } from "../src/mcp/auth";
export {
  CLOUD_AUTH_TOKEN_ISSUER,
  GUANLAN_INSTANCE_SERVICE_ID,
  GUANLAN_REQUIRED_SCOPE,
  GUANLAN_WRITE_SCOPE,
  resolveMcpConfig,
} from "../src/mcp/config";
