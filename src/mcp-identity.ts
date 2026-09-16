/**
 * The identity contract every caller of the orchestrator's tools is resolved to.
 *
 * `IdentityKind` distinguishes a human sign-in from in-process/system code today;
 * AII-702 adds `"run"` for a Restate-issued run capability. `Caller` is the shape
 * every tool handler receives (from AII-707 step 6 on) regardless of which kind
 * produced it.
 *
 * `RefreshAuthority` is the seam behind the MCP refresh-token grant: today's
 * `SqliteRefreshAuthority` (src/mcp-oauth.ts) is its only implementation, and this
 * issue does not change its behaviour — only gives it a swappable interface.
 */

import type { AccessRole } from "./access-entries.js";

export type IdentityKind = "human" | "system";

export interface Caller {
  kind: IdentityKind;
  email: string | null;
  role: AccessRole | null;
}

/** The identity in-process/system code acts under: unrestricted, unattributed to a person. */
export function systemCaller(): Caller {
  return { kind: "system", email: null, role: "admin" };
}

export interface RefreshInput {
  refreshToken: string;
  clientId: string;
}

/**
 * The outcome of rotating a refresh token, independent of how it is reported over HTTP.
 * `denied` carries the specific reason (invalid token, client_id mismatch, or an identity
 * the allowlist no longer admits) so the caller can preserve today's `error_description`
 * text; `replay` and `expired` map to a fixed description at the call site.
 */
export type RefreshOutcome =
  | { status: "ok"; accessToken: string; refreshToken: string; expiresInSeconds: number }
  | { status: "replay" }
  | { status: "expired" }
  | { status: "denied"; description: string }
  | { status: "unavailable" };

export interface RefreshAuthority {
  rotate(input: RefreshInput): Promise<RefreshOutcome>;
  revokeFamily(familyId: string): Promise<void>;
}
