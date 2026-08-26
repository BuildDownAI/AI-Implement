/**
 * Sign-in authorization — the OIDC preconditions that must hold before an identity is
 * matched against the allowlist. Provider-agnostic: the same gate covers Google,
 * Microsoft, and any future IdP.
 */

import type { VerifiedIdentity } from "./oidc.js";
import { matchAccessEntry, type AccessEntry } from "../access-entries.js";

/** Decide whether a freshly-authenticated identity may in. reason is for server-side logging, not the end user. */
export function authorize(
  identity: VerifiedIdentity,
  entries: AccessEntry[],
): { ok: true; entry: AccessEntry } | { ok: false; reason: string } {
  if (!identity.emailVerified) {
    return { ok: false, reason: `email address is not verified by the ${identity.provider}` };
  }
  if (!identity.email) {
    return { ok: false, reason: `${identity.provider} returned no email address` };
  }
  const entry = matchAccessEntry(identity, entries);
  if (!entry) return { ok: false, reason: `${identity.email} is not on the access allowlist` };
  return { ok: true, entry };
}
