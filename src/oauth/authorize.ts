/**
 * Authorization policy — decides whether an authenticated identity may access the admin UI.
 * Provider-agnostic so the same gate covers Google, Microsoft, and any future IdP.
 * Fail-closed: an empty allowlist denies everyone.
 */

import type { VerifiedIdentity } from "./oidc.js";

/** Who may access the admin UI. Empty lists deny everyone. */
export interface AuthorizationPolicy {
  allowedDomains: string[]; // email domains, e.g. ["eudoxus.ai"]
  allowedEmails: string[]; // explicit individual emails
}

// Singleton state: the normalized (lowercased) policy, empty until configured.
let policy: AuthorizationPolicy = { allowedDomains: [], allowedEmails: [] };

/** Seed the allowlist once at startup. Values are lowercased so matching is case-insensitive. */
export function configureAuthorizationPolicy(p: AuthorizationPolicy): void {
  policy = {
    allowedDomains: p.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean),
    allowedEmails: p.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean),
  };
}

export function getAuthorizationPolicy(): AuthorizationPolicy {
  return policy;
}

/** Decide whether a verified identity is allowed in. reason is for server-side logging, not the end user. */
export function authorize(identity: VerifiedIdentity): { ok: true } | { ok: false; reason: string } {
  if (!identity.emailVerified) {
    return { ok: false, reason: `email address is not verified by the ${identity.provider}` };
  }
  if (!identity.email) {
    return { ok: false, reason: `${identity.provider} returned no email address` };
  }

  const email = identity.email.trim().toLowerCase();
  const domain = email.split("@").pop() ?? "";

  if (policy.allowedEmails.includes(email)) return { ok: true };
  if (domain !== email && policy.allowedDomains.includes(domain)) return { ok: true };

  return { ok: false, reason: `${identity.email} is not on the access allowlist` };
}

/** Test hook: clear the policy back to the empty (deny-all) state. */
export function __resetAuthorizationPolicyForTest(): void {
  policy = { allowedDomains: [], allowedEmails: [] };
}
