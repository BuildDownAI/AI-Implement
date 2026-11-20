/**
 * Shared secret references for the knowledge-graph store.
 *
 * Dependency-free on purpose: `kg-graph-source.ts` imports `model-protected-secrets.ts` at runtime, so the
 * reference cannot live in either consumer without creating an import cycle.
 */

/** The `model_protected_secrets` reference that holds the Stardog Run access token. */
export const STARDOG_RUN_TOKEN_REF = "kg-store:stardog-run-token";
