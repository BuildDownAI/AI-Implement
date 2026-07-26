/**
 * OAuth/OIDC provider registry — the seam that makes Google, Microsoft, and any future OIDC issuer just configuration.
 * Seeded once at startup from env, read by the OAuth routes and the login screen.
 */

/** A configured OIDC identity provider. `issuer` is the discovery URL openid-client resolves metadata from. */
export interface OidcProviderConfig {
  id: string;       // stable key used in routes and the provider tag, e.g. "google", "microsoft"
  label: string;    // human label for the login button, e.g. "Google"
  issuer: string;   // OIDC issuer / discovery base URL
  clientId: string;
  clientSecret: string;
  scopes: string[]; // requested scopes, e.g. ["openid", "email", "profile"]
}

// Singleton state: the providers this orchestrator was configured with (empty until configured).
let providers: OidcProviderConfig[] = [];

/** Seed the configured providers once at startup. Callers pass only fully-credentialed entries. */
export function configureOAuthProviders(list: OidcProviderConfig[]): void {
  providers = list;
}

/** Look up a provider by id, or null when it isn't configured. */
export function getProvider(id: string): OidcProviderConfig | null {
  return providers.find((p) => p.id === id) ?? null;
}

/** The id+label of every configured provider — what the login screen needs to render its buttons. */
export function listConfiguredProviders(): Array<{ id: string; label: string }> {
  return providers.map((p) => ({ id: p.id, label: p.label }));
}

/** Whether any OIDC provider is configured — the "is SSO available?" signal (used by the 503-gate). */
export function isOAuthConfigured(): boolean {
  return providers.length > 0;
}

/** Build the provider list from env — Google and/or Microsoft, each included only when fully credentialed. */
export function providersFromEnv(env: NodeJS.ProcessEnv): OidcProviderConfig[] {
  const scopes = ["openid", "email", "profile"];
  const list: OidcProviderConfig[] = [];
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    list.push({
      id: "google",
      label: "Google",
      issuer: "https://accounts.google.com",
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      scopes,
    });
  }
  if (env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET && env.MICROSOFT_OAUTH_TENANT) {
    list.push({
      id: "microsoft",
      label: "Microsoft",
      issuer: `https://login.microsoftonline.com/${env.MICROSOFT_OAUTH_TENANT}/v2.0`,
      clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
      clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
      scopes,
    });
  }
  return list;
}

/** Test hook: clear configured providers back to the empty (unconfigured) state. */
export function __resetOAuthProvidersForTest(): void {
  providers = [];
}
