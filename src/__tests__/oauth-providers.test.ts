import { describe, it, expect, beforeEach } from "vitest";
import {
  configureOAuthProviders,
  getProvider,
  listConfiguredProviders,
  isOAuthConfigured,
  resolveProviders,
  unsetVariables,
  __resetOAuthProvidersForTest,
  type OidcProviderConfig,
} from "../oauth/providers.js";

const google: OidcProviderConfig = {
  id: "google",
  label: "Google",
  issuer: "https://accounts.google.com",
  clientId: "gid",
  clientSecret: "gsecret",
  scopes: ["openid", "email", "profile"],
};
const microsoft: OidcProviderConfig = {
  id: "microsoft",
  label: "Microsoft",
  issuer: "https://login.microsoftonline.com/tenant/v2.0",
  clientId: "mid",
  clientSecret: "msecret",
  scopes: ["openid", "email", "profile"],
};

beforeEach(() => __resetOAuthProvidersForTest());

describe("provider registry", () => {
  it("reports unconfigured before any providers are set", () => {
    expect(isOAuthConfigured()).toBe(false);
    expect(listConfiguredProviders()).toEqual([]);
    expect(getProvider("google")).toBeNull();
  });

  it("registers configured providers and looks them up by id", () => {
    configureOAuthProviders([google, microsoft]);
    expect(isOAuthConfigured()).toBe(true);
    expect(getProvider("google")).toEqual(google);
    expect(getProvider("microsoft")).toEqual(microsoft);
    expect(getProvider("unknown")).toBeNull();
  });

  it("exposes only id+label publicly — never the client secret", () => {
    configureOAuthProviders([google, microsoft]);
    const listed = listConfiguredProviders();
    expect(listed).toEqual([
      { id: "google", label: "Google" },
      { id: "microsoft", label: "Microsoft" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("gsecret");
    expect(JSON.stringify(listed)).not.toContain("msecret");
  });

  it("replaces the set on reconfigure", () => {
    configureOAuthProviders([google, microsoft]);
    configureOAuthProviders([google]);
    expect(listConfiguredProviders()).toEqual([{ id: "google", label: "Google" }]);
    expect(getProvider("microsoft")).toBeNull();
  });
});

describe("unsetVariables", () => {
  it("names each variable that is absent or empty, in the order asked", () => {
    expect(unsetVariables({ A: "1", B: "", D: "4" }, ["A", "B", "C", "D"])).toEqual(["B", "C"]);
  });
});

describe("resolveProviders", () => {
  const scopes = ["openid", "email", "profile"];

  it("returns no providers and drops nothing when no provider variable is set", () => {
    expect(resolveProviders({})).toEqual({ providers: [], dropped: [] });
  });

  it("includes Google when its id + secret are set", () => {
    expect(resolveProviders({ GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gs" }).providers).toEqual([
      { id: "google", label: "Google", issuer: "https://accounts.google.com", clientId: "gid", clientSecret: "gs", scopes },
    ]);
  });

  it("includes Microsoft only when id + secret + tenant are all set (issuer embeds the tenant)", () => {
    expect(resolveProviders({ MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s" }).providers).toEqual([]);
    expect(
      resolveProviders({ MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s", MICROSOFT_OAUTH_TENANT: "t1" }).providers,
    ).toEqual([
      { id: "microsoft", label: "Microsoft", issuer: "https://login.microsoftonline.com/t1/v2.0", clientId: "m", clientSecret: "s", scopes },
    ]);
  });

  it("includes both when both are credentialed, google first", () => {
    const { providers } = resolveProviders({
      GOOGLE_OAUTH_CLIENT_ID: "g",
      GOOGLE_OAUTH_CLIENT_SECRET: "gs",
      MICROSOFT_OAUTH_CLIENT_ID: "m",
      MICROSOFT_OAUTH_CLIENT_SECRET: "ms",
      MICROSOFT_OAUTH_TENANT: "t",
    });
    expect(providers.map((p) => p.id)).toEqual(["google", "microsoft"]);
  });

  it("drops a partly configured provider, naming its unset variables", () => {
    expect(resolveProviders({ GOOGLE_OAUTH_CLIENT_ID: "g" })).toEqual({
      providers: [],
      dropped: [{ id: "google", reason: "GOOGLE_OAUTH_CLIENT_SECRET not set" }],
    });
    expect(resolveProviders({ MICROSOFT_OAUTH_CLIENT_ID: "m" }).dropped).toEqual([
      { id: "microsoft", reason: "MICROSOFT_OAUTH_CLIENT_SECRET and MICROSOFT_OAUTH_TENANT not set" },
    ]);
  });

  it.each(["common", "organizations", "consumers", "Common"])("drops Microsoft with the multi-tenant value %j", (tenant) => {
    const env = { MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s", MICROSOFT_OAUTH_TENANT: tenant };
    expect(resolveProviders(env)).toEqual({
      providers: [],
      dropped: [{ id: "microsoft", reason: "MICROSOFT_OAUTH_TENANT is a multi-tenant value. Set it to your tenant's ID." }],
    });
  });

  it("gives each provider its own scopes array", () => {
    const { providers } = resolveProviders({ GOOGLE_OAUTH_CLIENT_ID: "g", GOOGLE_OAUTH_CLIENT_SECRET: "gs" });
    providers[0].scopes.push("offline_access");
    expect(resolveProviders({ GOOGLE_OAUTH_CLIENT_ID: "g", GOOGLE_OAUTH_CLIENT_SECRET: "gs" }).providers[0].scopes).toEqual(scopes);
  });
});

describe("resolveProviders — BuildDown", () => {
  const scopes = ["openid", "email", "profile"];
  const bd = {
    BUILDDOWN_OIDC_ISSUER: "https://cp.example.com",
    BUILDDOWN_OIDC_CLIENT_ID: "bid",
    BUILDDOWN_OIDC_CLIENT_SECRET: "bsecret",
  };
  const goog = { GOOGLE_OAUTH_CLIENT_ID: "g", GOOGLE_OAUTH_CLIENT_SECRET: "gs" };
  const ms = { MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "ms", MICROSOFT_OAUTH_TENANT: "t" };

  it("builds the BuildDown entry", () => {
    expect(resolveProviders(bd).providers).toEqual([
      { id: "builddown", label: "BuildDown", issuer: "https://cp.example.com", clientId: "bid", clientSecret: "bsecret", scopes },
    ]);
  });

  it("lists builddown first, ahead of google and microsoft, including after configuration", () => {
    const { providers } = resolveProviders({ ...goog, ...ms, ...bd });
    expect(providers.map((p) => p.id)).toEqual(["builddown", "google", "microsoft"]);
    configureOAuthProviders(providers);
    expect(listConfiguredProviders().map((p) => p.id)).toEqual(["builddown", "google", "microsoft"]);
  });

  it.each(Object.keys(bd))("omits builddown when %s is missing or empty, naming it and leaving others unchanged", (key) => {
    const baseline = resolveProviders({ ...goog, ...ms }).providers;
    for (const value of [undefined, ""]) {
      const env: Record<string, string | undefined> = { ...goog, ...ms, ...bd, [key]: value };
      expect(resolveProviders(env)).toEqual({ providers: baseline, dropped: [{ id: "builddown", reason: `${key} not set` }] });
    }
  });

  it.each(["http://cp.example.com", "HTTPS://cp.example.com", " https://cp.example.com"])(
    "rejects issuer %j with a reason that omits the secret",
    (issuer) => {
      const { providers, dropped } = resolveProviders({ ...goog, ...bd, BUILDDOWN_OIDC_ISSUER: issuer });
      expect(providers.map((p) => p.id)).toEqual(["google"]);
      expect(dropped).toEqual([{ id: "builddown", reason: "BUILDDOWN_OIDC_ISSUER does not start with https://" }]);
      expect(JSON.stringify(dropped)).not.toContain("bsecret");
    },
  );

  it("stores the issuer as given, trailing slash included", () => {
    expect(resolveProviders({ ...bd, BUILDDOWN_OIDC_ISSUER: "https://cp.example.com/" }).providers[0].issuer).toBe("https://cp.example.com/");
  });
});
