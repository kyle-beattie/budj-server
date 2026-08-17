/**
 * D9: losing entitlement revokes bank access. It does not merely gate the UI.
 *
 * Two reasons it has to be real. Akahu bills per connected user, so a
 * gated-but-connected cancelled account is a recurring cost with no revenue.
 * And once `add-rule-triggers` lands, a live connection still receiving
 * transaction events for a non-paying user is the system doing work nobody
 * authorised.
 *
 * Billing declares the need; `bank-connections` implements it
 * (`AkahuBankAccessRevoker`). The dependency runs one way — billing knows it
 * must revoke, and knows nothing about how.
 */
export interface BankAccessRevoker {
  /** Idempotent: revoking an already-revoked user must be a no-op, not an error. */
  revoke(userId: string): Promise<void>;
}
