/**
 * OAuth/OIDC provider registry — the seam that makes Google, Microsoft, BuildDown, and any future OIDC issuer just configuration.
 * Seeded once at startup from env, read by the OAuth routes and the login screen.
 */

/** A configured OIDC identity provider. `issuer` is the discovery URL openid-client resolves metadata from. */
export interface OidcProviderConfig {
  id: string;       // stable key used in routes and the provider tag, e.g. "google", "microsoft", "builddown"
  label: string;    // human label for the login button, e.g. "Google"
  issuer: string;   // OIDC issuer / discovery base URL
  clientId: string;
  clientSecret: string;
  scopes: string[]; // requested scopes, e.g. ["openid", "email", "profile"]
}

/** A sign-in provider: the variables that configure it, and how it is built once all of them are set. */
interface ProviderSpec {
  id: string;
  variables: readonly string[];
  /** The provider, or why its values cannot be used. */
  build(env: NodeJS.ProcessEnv): OidcProviderConfig | { reason: string };
}

/** A provider whose variables are set but cannot be used, and why. */
export interface DroppedProvider {
  id: string;
  reason: string;
}

// Singleton state: the providers this orchestrator was configured with (empty until configured).
let providers: OidcProviderConfig[] = [];

const OIDC_SCOPES = ["openid", "email", "profile"];

/** BuildDown comes first: `/mcp/authorize` uses `providers[0]` when the client names no provider. */
const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    id: "builddown",
    variables: ["BUILDDOWN_OIDC_ISSUER", "BUILDDOWN_OIDC_CLIENT_ID", "BUILDDOWN_OIDC_CLIENT_SECRET"],
    build: (env) => {
      // Strict prefix, no trimming or case-folding: an http:// issuer lets a network attacker swap the JWKS.
      // The issuer is stored as given — openid-client matches it against the token's `iss` claim.
      if (!env.BUILDDOWN_OIDC_ISSUER!.startsWith("https://")) return { reason: "BUILDDOWN_OIDC_ISSUER does not start with https://" };
      return {
        id: "builddown",
        label: "BuildDown",
        issuer: env.BUILDDOWN_OIDC_ISSUER!,
        clientId: env.BUILDDOWN_OIDC_CLIENT_ID!,
        clientSecret: env.BUILDDOWN_OIDC_CLIENT_SECRET!,
        scopes: [...OIDC_SCOPES],
      };
    },
  },
  {
    id: "google",
    variables: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    build: (env) => ({
      id: "google",
      label: "Google",
      issuer: "https://accounts.google.com",
      clientId: env.GOOGLE_OAUTH_CLIENT_ID!,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      scopes: [...OIDC_SCOPES],
    }),
  },
  {
    id: "microsoft",
    variables: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT"],
    build: (env) => {
      // Microsoft's tid-based "email verified" holds only for a single-tenant issuer.
      if (["common", "organizations", "consumers"].includes(env.MICROSOFT_OAUTH_TENANT!.toLowerCase())) {
        return { reason: "MICROSOFT_OAUTH_TENANT is a multi-tenant value. Set it to your tenant's ID." };
      }
      return {
        id: "microsoft",
        label: "Microsoft",
        issuer: `https://login.microsoftonline.com/${env.MICROSOFT_OAUTH_TENANT}/v2.0`,
        clientId: env.MICROSOFT_OAUTH_CLIENT_ID!,
        clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
        scopes: [...OIDC_SCOPES],
      };
    },
  },
];

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

/** The variables in `names` that `env` leaves unset or empty. */
export function unsetVariables(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]);
}

/**
 * The usable providers from env, and the ones dropped. A provider with none of its variables set is
 * absent; one with only some set is dropped, naming the rest.
 */
export function resolveProviders(env: NodeJS.ProcessEnv): { providers: OidcProviderConfig[]; dropped: DroppedProvider[] } {
  const providers: OidcProviderConfig[] = [];
  const dropped: DroppedProvider[] = [];
  for (const spec of PROVIDER_SPECS) {
    const unset = unsetVariables(env, spec.variables);
    if (unset.length === spec.variables.length) continue;
    if (unset.length > 0) {
      dropped.push({ id: spec.id, reason: `${unset.join(" and ")} not set` });
      continue;
    }
    const built = spec.build(env);
    if ("reason" in built) dropped.push({ id: spec.id, reason: built.reason });
    else providers.push(built);
  }
  return { providers, dropped };
}

/** Test hook: clear configured providers back to the empty (unconfigured) state. */
export function __resetOAuthProvidersForTest(): void {
  providers = [];
}
