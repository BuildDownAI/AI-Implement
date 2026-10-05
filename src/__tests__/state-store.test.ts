import { describe, it, expect, beforeEach } from "vitest";
import type { OAuthTransaction } from "../oauth/state-store.js";
import { testDb } from "./helpers/test-db.js";

let store: typeof import("../oauth/state-store.js");
let dedup: typeof import("../dedup.js");

const tx = (over: Partial<OAuthTransaction> = {}): OAuthTransaction => ({
  state: "state-1",
  provider: "google",
  codeVerifier: "verifier-1",
  nonce: "nonce-1",
  redirectTo: "/admin",
  ...over,
});

beforeEach(async () => {
  ({ store, dedup } = (
    await testDb({ modules: { store: () => import("../oauth/state-store.js"), dedup: () => import("../dedup.js") } })
  ).modules);
});

describe("oauth transaction store", () => {
  it("round-trips a stored transaction by state", () => {
    store.putTransaction(tx({ state: "abc", provider: "microsoft", codeVerifier: "v", nonce: "n", redirectTo: "/admin#x" }));
    expect(store.takeTransaction("abc")).toEqual({
      state: "abc",
      provider: "microsoft",
      codeVerifier: "v",
      nonce: "n",
      redirectTo: "/admin#x",
    });
  });

  it("is single-use: a second take of the same state returns null", () => {
    store.putTransaction(tx({ state: "once" }));
    expect(store.takeTransaction("once")).not.toBeNull();
    expect(store.takeTransaction("once")).toBeNull();
  });

  it("returns null for an unknown state", () => {
    expect(store.takeTransaction("nope")).toBeNull();
  });

  it("returns null for an expired transaction, but still consumes the row", () => {
    store.putTransaction(tx({ state: "old" }));
    dedup.getDb().prepare("UPDATE oauth_transactions SET expires_at = ? WHERE state = ?").run(Date.now() - 1, "old");
    expect(store.takeTransaction("old")).toBeNull();
    const row = dedup.getDb().prepare("SELECT 1 FROM oauth_transactions WHERE state = ?").get("old");
    expect(row).toBeUndefined();
  });

  it("keeps distinct states independent", () => {
    store.putTransaction(tx({ state: "a", provider: "google" }));
    store.putTransaction(tx({ state: "b", provider: "microsoft" }));
    expect(store.takeTransaction("a")?.provider).toBe("google");
    expect(store.takeTransaction("b")?.provider).toBe("microsoft");
  });

  it("stores an expiry exactly OAUTH_TX_TTL_MS after creation", () => {
    store.putTransaction(tx({ state: "ttl" }));
    const row = dedup
      .getDb()
      .prepare("SELECT expires_at, created_at FROM oauth_transactions WHERE state = ?")
      .get("ttl") as { expires_at: number; created_at: number };
    expect(row.expires_at - row.created_at).toBe(store.OAUTH_TX_TTL_MS);
  });
});
