/**
 * Transient OAuth login state — the state/nonce/PKCE-verifier the callback must verify against, held server-side keyed by the unguessable `state`.
 * Single-use and short-lived: consumed on read, swept after expiry.
 * Distinct from admin_sessions (a different lifecycle).
 */

import { getDb } from "../dedup.js";

export const OAUTH_TX_TTL_MS = 10 * 60 * 1000; // 10 minutes — a login round-trip is quick

export interface OAuthTransaction {
  state: string;
  provider: string;
  codeVerifier: string;
  nonce: string;
  redirectTo: string; // validated local path to return to after login
}

/** Persist the per-login state the callback will verify. */
export function putTransaction(tx: OAuthTransaction): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO oauth_transactions (state, provider, code_verifier, nonce, redirect_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(tx.state, tx.provider, tx.codeVerifier, tx.nonce, tx.redirectTo, now, now + OAUTH_TX_TTL_MS);
}

/** Consume a transaction by state: single-use (deleted on read) and only valid if unexpired. */
export function takeTransaction(state: string): OAuthTransaction | null {
  const db = getDb();
  const row = db
    .prepare("SELECT provider, code_verifier, nonce, redirect_to, expires_at FROM oauth_transactions WHERE state = ?")
    .get(state) as
    | { provider: string; code_verifier: string; nonce: string; redirect_to: string; expires_at: number }
    | undefined;
  if (!row) return null;

  // Delete unconditionally — a state is spent the moment it's presented, valid or not.
  db.prepare("DELETE FROM oauth_transactions WHERE state = ?").run(state);
  if (Date.now() > row.expires_at) return null;
  return { state, provider: row.provider, codeVerifier: row.code_verifier, nonce: row.nonce, redirectTo: row.redirect_to };
}
