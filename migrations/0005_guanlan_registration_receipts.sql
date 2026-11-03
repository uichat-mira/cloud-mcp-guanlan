-- GLN-015: delivery receipts for Cloud Auth account-space registration.
--
-- Why a receipt table exists: the receiver must be able to tell "this account
-- was never registered" apart from "this account was registered and its space
-- was later torn down or deleted". Without that distinction a replayed or
-- reactivated delivery could silently recreate a space that an operator had
-- deliberately removed, i.e. resurrect an account that must stay gone.
--
-- This table records only delivery bookkeeping (when, how many times). It never
-- carries credentials, Cloud Session material, profile data or any news state.
CREATE TABLE guanlan_registration_receipts (
  account_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(account_id) BETWEEN 1 AND 128 AND account_id = trim(account_id)
  ),
  first_delivered_at TEXT NOT NULL,
  last_delivered_at TEXT NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 1 CHECK (deliveries >= 1)
);
