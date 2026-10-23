/**
 * Sign-in authorization — the OIDC preconditions that must hold before an identity is
 * matched against the allowlist. Provider-agnostic: the same gate covers Google,
 * Microsoft, and any future IdP.
 */

import type { VerifiedIdentity } from "./oidc.js";
import { matchAccessEntry, type AccessEntry, type AccessRole } from "../access-entries.js";

/** The organization role claim the control plane puts in a BuildDown ID token → the role it admits as. */
const ORG_ROLE_TO_ACCESS_ROLE: Record<string, AccessRole> = { owner: "admin", admin: "admin", member: "user" };

/** The role a `builddown` identity's organization claim grants, or null. Any other provider, or value, grants nothing. */
function orgClaimRole(identity: VerifiedIdentity): AccessRole | null {
  if (identity.provider !== "builddown") return null;
  const claim = identity.rawClaims?.builddown_org_role;
  if (typeof claim !== "string" || !Object.hasOwn(ORG_ROLE_TO_ACCESS_ROLE, claim)) return null;
  return ORG_ROLE_TO_ACCESS_ROLE[claim];
}

/** Where an admission came from: a stored allowlist entry, or the BuildDown organization role claim. */
export type AdmitSource = "stored" | "org-claim";

/** Decide whether a freshly-authenticated identity may in. reason is for server-side logging, not the end user. */
export function authorize(
  identity: VerifiedIdentity,
  entries: AccessEntry[],
): { ok: true; entry: AccessEntry; source: AdmitSource } | { ok: false; reason: string } {
  if (!identity.emailVerified) {
    return { ok: false, reason: `email address is not verified by the ${identity.provider}` };
  }
  if (!identity.email) {
    return { ok: false, reason: `${identity.provider} returned no email address` };
  }
  const stored = matchAccessEntry(identity, entries);
  const claimRole = orgClaimRole(identity);
  // A stored entry wins unless the claim grants a strictly higher role.
  if (claimRole && (!stored || (claimRole === "admin" && stored.role !== "admin"))) {
    // Synthetic and never persisted: binding writes access_entry_bindings only, so leaving the organization ends access.
    const synthetic: AccessEntry = {
      kind: "address",
      value: identity.email.trim().toLowerCase(),
      role: claimRole,
      bindings: [],
      addedAt: 0,
      addedBy: null,
    };
    return { ok: true, entry: synthetic, source: "org-claim" };
  }
  if (!stored) return { ok: false, reason: `${identity.email} is not on the access allowlist` };
  return { ok: true, entry: stored, source: "stored" };
}
