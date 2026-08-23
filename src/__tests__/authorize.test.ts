import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { VerifiedIdentity } from "../oauth/oidc.js";
import type { AccessEntry } from "../access-entries.js";

// authorize.ts imports access-entries.ts, which imports dedup.ts — and dedup resolves (and
// creates) its directory at module load. Setting the path before the dynamic import keeps this
// suite off /data. Nothing here calls getDb(), so no database file is ever opened.
let authz: typeof import("../oauth/authorize.js");

beforeEach(async () => {
  vi.resetModules();
  process.env.DEDUP_DB_PATH = path.join(
    os.tmpdir(),
    `authorize-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  authz = await import("../oauth/authorize.js");
});

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  sub: "google|1",
  email: "ada@eudoxus.ai",
  emailVerified: true,
  name: "Ada",
  hd: "eudoxus.ai",
  tid: null,
  rawClaims: {},
  ...over,
});

const entry = (over: Partial<AccessEntry> = {}): AccessEntry => ({
  kind: "address",
  value: "ada@eudoxus.ai",
  role: "admin",
  provider: null,
  subject: null,
  addedAt: 0,
  addedBy: null,
  ...over,
});

describe("authorize", () => {
  it("denies everyone when the list is empty (fail-closed)", () => {
    expect(authz.authorize(identity(), []).ok).toBe(false);
  });

  it("allows a verified email whose domain is listed", () => {
    const domain = entry({ kind: "domain", value: "eudoxus.ai", role: "user" });
    const result = authz.authorize(identity({ email: "ada@eudoxus.ai" }), [domain]);
    expect(result).toEqual({ ok: true, entry: domain });
  });

  it("allows an address listed explicitly, even off any listed domain", () => {
    const listed = entry({ value: "contractor@gmail.com" });
    const result = authz.authorize(identity({ email: "contractor@gmail.com" }), [listed]);
    expect(result).toEqual({ ok: true, entry: listed });
  });

  it("returns the matching entry, which is what carries the role and the binding target", () => {
    const listed = entry({ value: "ada@eudoxus.ai", role: "admin" });
    const result = authz.authorize(identity(), [listed]);
    expect(result.ok && result.entry.role).toBe("admin");
  });

  it("denies an unverified email regardless of the list", () => {
    const result = authz.authorize(identity({ emailVerified: false }), [entry()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not verified/);
  });

  it("denies when the provider returned no email", () => {
    const result = authz.authorize(identity({ email: null }), [entry()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no email/);
  });

  it("denies a verified email that is neither listed nor on a listed domain", () => {
    const result = authz.authorize(identity({ email: "someone@evil.com" }), [
      entry({ kind: "domain", value: "eudoxus.ai", role: "user" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not on the access allowlist/);
  });

  it("folds the identity's email before matching, so provider casing does not matter", () => {
    const domain = entry({ kind: "domain", value: "eudoxus.ai", role: "user" });
    expect(authz.authorize(identity({ email: " Ada@EUDOXUS.ai " }), [domain]).ok).toBe(true);
  });

  it("does not treat a malformed, @-less identifier as its own domain", () => {
    // "noatsign".split("@").pop() === "noatsign" === email → the domain check must be skipped
    const domain = entry({ kind: "domain", value: "noatsign", role: "user" });
    expect(authz.authorize(identity({ email: "noatsign" }), [domain]).ok).toBe(false);
  });
});
