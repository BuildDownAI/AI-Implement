import { describe, it, expect, beforeEach } from "vitest";
import type { VerifiedIdentity } from "../oauth/oidc.js";
import type { AccessEntry } from "../access-entries.js";
import { testDb } from "./helpers/test-db.js";

// Nothing here calls getDb(), so no database file is ever opened.
let authz: typeof import("../oauth/authorize.js");

beforeEach(async () => {
  ({ authz } = (await testDb({ tables: "none", modules: { authz: () => import("../oauth/authorize.js") } })).modules);
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
  bindings: [],
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
    expect(result).toEqual({ ok: true, entry: domain, source: "stored" });
  });

  it("allows an address listed explicitly, even off any listed domain", () => {
    const listed = entry({ value: "contractor@gmail.com" });
    const result = authz.authorize(identity({ email: "contractor@gmail.com" }), [listed]);
    expect(result).toEqual({ ok: true, entry: listed, source: "stored" });
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

  describe("BuildDown organization role claim", () => {
    const bd = (role: unknown, over: Partial<VerifiedIdentity> = {}) =>
      identity({ provider: "builddown", sub: "bd|1", rawClaims: { builddown_org_role: role }, ...over });

    it("admits member as user, and admin/owner as admin, with a synthetic address entry", () => {
      for (const [claim, role] of [["member", "user"], ["admin", "admin"], ["owner", "admin"]] as const) {
        const result = authz.authorize(bd(claim), []);
        expect(result).toMatchObject({ ok: true, source: "org-claim", entry: { kind: "address", value: "ada@eudoxus.ai", role, bindings: [] } });
      }
    });

    it("refuses builddown with no claim and no stored entry", () => {
      expect(authz.authorize(identity({ provider: "builddown", sub: "bd|1" }), []).ok).toBe(false);
    });

    it("ignores the claim on other providers", () => {
      for (const provider of ["google", "microsoft"]) {
        expect(authz.authorize(bd("admin", { provider }), []).ok).toBe(false);
      }
    });

    it("ignores unknown values, and still requires a verified email", () => {
      for (const claim of ["superuser", "", 1, null, "OWNER", "toString"]) {
        expect(authz.authorize(bd(claim), []).ok).toBe(false);
      }
      expect(authz.authorize(bd("admin", { emailVerified: false }), []).ok).toBe(false);
      expect(authz.authorize(bd("admin", { email: null }), []).ok).toBe(false);
    });

    it("lets a higher stored role win, and a higher claim win over a lower stored role", () => {
      const admin = entry({ role: "admin" });
      expect(authz.authorize(bd("member"), [admin])).toEqual({ ok: true, entry: admin, source: "stored" });
      const user = entry({ role: "user" });
      expect(authz.authorize(bd("admin"), [user])).toMatchObject({ ok: true, source: "org-claim", entry: { role: "admin" } });
      expect(authz.authorize(bd("member"), [user])).toEqual({ ok: true, entry: user, source: "stored" });
    });

    it("lets a claim give admin over a stored domain entry", () => {
      const domain = entry({ kind: "domain", value: "eudoxus.ai", role: "user" });
      expect(authz.authorize(bd("owner"), [domain])).toMatchObject({ ok: true, entry: { role: "admin", kind: "address" } });
    });
  });
});
