/**
 * The `internal` custom claim (GRV-113): whether an account belongs to the
 * team or is a test account, so its sessions and its kept assistant turns are
 * counted as internal and kept out of the product's measures.
 *
 * Like `admin` (#854), it is a Firebase Auth custom claim, so only trusted code
 * holding the Admin SDK can set it: `bun run internal:grant` /
 * `internal:revoke` (`scripts/access/`) and QA pool provisioning
 * (`provisionQaAccounts`). Neither the client SDK nor the Auth REST API lets
 * an account set a claim on itself. It reaches the browser in the account's ID
 * token (`authService.isInternal`) and the assistant callable in the verified
 * token it is called with (`functions/src/assistantHandler.ts`).
 *
 * Which accounts are internal is data, set per account. No address, address
 * pattern or domain is written down here or anywhere in the client bundle.
 *
 * Like the rest of `src/access`, this imports nothing from Firebase.
 */

/** The claim's name in an ID token. */
export const INTERNAL_CLAIM = "internal";

/** An ID token's claims, or the custom claims on an Auth user record. */
export type Claims = Readonly<Record<string, unknown>> | null | undefined;

/**
 * Whether the claims mark the account internal. Only the boolean `true`
 * counts; a missing claim, or any other value, is not internal.
 */
export function hasInternalClaim(claims: Claims): boolean {
  return claims?.[INTERNAL_CLAIM] === true;
}

/**
 * The custom claims to set so the account is (`internal: true`) or is not
 * internal, keeping every other claim it has (`admin` above all). Revoking
 * removes the claim rather than writing `false`, so a revoked account's token
 * is the same as one that was never flagged.
 */
export function withInternalClaim(
  claims: Claims,
  internal: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(claims ?? {}) };
  if (internal) {
    next[INTERNAL_CLAIM] = true;
  } else {
    delete next[INTERNAL_CLAIM];
  }
  return next;
}
