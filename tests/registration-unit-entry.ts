/**
 * GLN-015 unit-test entry: bundles the receiver's pure validation surface so the
 * T1 suite can exercise it without a Worker, a database or the network.
 */
export {
  handleRegistration,
  verifyRegistrationRequest,
  applyRegistration,
  REGISTRATION_PATH,
  MAX_REGISTRATION_BODY_BYTES,
  REGISTRATION_TIMESTAMP_WINDOW_SECONDS,
  REGISTRATION_SECRET_MIN_LENGTH,
} from "../src/registration";
