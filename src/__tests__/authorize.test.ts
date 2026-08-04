import { describe, it, expect, beforeEach } from "vitest";
import {
  configureAuthorizationPolicy,
  authorize,
  getAuthorizationPolicy,
  __resetAuthorizationPolicyForTest,
} from "../oauth/authorize.js";
import type { VerifiedIdentity } from "../oauth/oidc.js";

const identity = (over: Partial<VerifiedIdentity>): VerifiedIdentity => ({
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

beforeEach(() => __resetAuthorizationPolicyForTest());

describe("authorize", () => {
  it("denies everyone when the policy is empty (fail-closed)", () => {
    expect(authorize(identity({})).ok).toBe(false);
  });

  it("allows a verified email whose domain is on the allowlist", () => {
    configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: [] });
    expect(authorize(identity({ email: "ada@eudoxus.ai" }))).toEqual({ ok: true });
  });

  it("allows a verified email listed explicitly, even off an allowed domain", () => {
    configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: ["contractor@gmail.com"] });
    expect(authorize(identity({ email: "contractor@gmail.com" }))).toEqual({ ok: true });
  });

  it("denies an unverified email regardless of the allowlist", () => {
    configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: [] });
    const result = authorize(identity({ email: "ada@eudoxus.ai", emailVerified: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not verified/);
  });

  it("denies when the provider returned no email", () => {
    configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: [] });
    const result = authorize(identity({ email: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no email/);
  });

  it("denies a verified email that is neither listed nor on an allowed domain", () => {
    configureAuthorizationPolicy({ allowedDomains: ["eudoxus.ai"], allowedEmails: [] });
    expect(authorize(identity({ email: "someone@evil.com" })).ok).toBe(false);
  });

  it("matches case-insensitively on email and domain, trimming/dropping empty config entries", () => {
    configureAuthorizationPolicy({ allowedDomains: [" Eudoxus.AI ", ""], allowedEmails: [] });
    expect(authorize(identity({ email: "Ada@EUDOXUS.ai" }))).toEqual({ ok: true });
  });

  it("does not treat a malformed, @-less identifier as a domain", () => {
    // "noatsign".split("@").pop() === "noatsign" === email → the domain check must be skipped
    configureAuthorizationPolicy({ allowedDomains: ["noatsign"], allowedEmails: [] });
    expect(authorize(identity({ email: "noatsign" })).ok).toBe(false);
  });

  it("stores the normalized (lowercased, trimmed, compacted) policy", () => {
    configureAuthorizationPolicy({ allowedDomains: ["Eudoxus.AI"], allowedEmails: ["Ada@Eudoxus.ai", "  "] });
    expect(getAuthorizationPolicy()).toEqual({
      allowedDomains: ["eudoxus.ai"],
      allowedEmails: ["ada@eudoxus.ai"],
    });
  });
});
