import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureOAuthProviders,
  getProvider,
  listConfiguredProviders,
  isOAuthConfigured,
  providersFromEnv,
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

describe("providersFromEnv", () => {
  const scopes = ["openid", "email", "profile"];

  it("returns [] when no provider is credentialed", () => {
    expect(providersFromEnv({})).toEqual([]);
  });

  it("includes Google when its id + secret are set", () => {
    expect(providersFromEnv({ GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gs" })).toEqual([
      { id: "google", label: "Google", issuer: "https://accounts.google.com", clientId: "gid", clientSecret: "gs", scopes },
    ]);
  });

  it("includes Microsoft only when id + secret + tenant are all set (issuer embeds the tenant)", () => {
    expect(providersFromEnv({ MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s" })).toEqual([]);
    expect(
      providersFromEnv({ MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s", MICROSOFT_OAUTH_TENANT: "t1" }),
    ).toEqual([
      { id: "microsoft", label: "Microsoft", issuer: "https://login.microsoftonline.com/t1/v2.0", clientId: "m", clientSecret: "s", scopes },
    ]);
  });

  it("includes both when both are credentialed, google first", () => {
    const list = providersFromEnv({
      GOOGLE_OAUTH_CLIENT_ID: "g",
      GOOGLE_OAUTH_CLIENT_SECRET: "gs",
      MICROSOFT_OAUTH_CLIENT_ID: "m",
      MICROSOFT_OAUTH_CLIENT_SECRET: "ms",
      MICROSOFT_OAUTH_TENANT: "t",
    });
    expect(list.map((p) => p.id)).toEqual(["google", "microsoft"]);
  });
});

describe("providersFromEnv — BuildDown", () => {
  const scopes = ["openid", "email", "profile"];
  const bd = {
    BUILDDOWN_OIDC_ISSUER: "https://cp.example.com",
    BUILDDOWN_OIDC_CLIENT_ID: "bid",
    BUILDDOWN_OIDC_CLIENT_SECRET: "bsecret",
  };
  const goog = { GOOGLE_OAUTH_CLIENT_ID: "g", GOOGLE_OAUTH_CLIENT_SECRET: "gs" };
  const ms = { MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "ms", MICROSOFT_OAUTH_TENANT: "t" };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("builds the BuildDown entry", () => {
    expect(providersFromEnv(bd)).toEqual([
      { id: "builddown", label: "BuildDown", issuer: "https://cp.example.com", clientId: "bid", clientSecret: "bsecret", scopes },
    ]);
  });

  it("lists builddown first, ahead of google and microsoft, including after configuration", () => {
    const list = providersFromEnv({ ...goog, ...ms, ...bd });
    expect(list.map((p) => p.id)).toEqual(["builddown", "google", "microsoft"]);
    configureOAuthProviders(list);
    expect(listConfiguredProviders().map((p) => p.id)).toEqual(["builddown", "google", "microsoft"]);
  });

  it.each(Object.keys(bd))("omits builddown when %s is missing or empty, leaving others unchanged", (key) => {
    const baseline = providersFromEnv({ ...goog, ...ms });
    for (const value of [undefined, ""]) {
      const env: Record<string, string | undefined> = { ...goog, ...ms, ...bd, [key]: value };
      expect(providersFromEnv(env)).toEqual(baseline);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["http://cp.example.com", "HTTPS://cp.example.com", " https://cp.example.com"])(
    "rejects issuer %j with one warning that omits the secret",
    (issuer) => {
      expect(providersFromEnv({ ...goog, ...bd, BUILDDOWN_OIDC_ISSUER: issuer }).map((p) => p.id)).toEqual(["google"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("bsecret");
    },
  );

  it("stores the issuer as given, trailing slash included", () => {
    expect(providersFromEnv({ ...bd, BUILDDOWN_OIDC_ISSUER: "https://cp.example.com/" })[0].issuer).toBe("https://cp.example.com/");
  });
});
