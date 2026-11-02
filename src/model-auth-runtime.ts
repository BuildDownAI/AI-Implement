/**
 * Production composition of the model-auth dependencies (AII-1385) that `prepareAgentRun` and the model-auth
 * routes need. No consumer exists yet; later leaves of AII-958 wire it into dispatch.
 *
 * Every store here is a stateless wrapper over `getDb()`, so one process-wide instance is safe. Rules fixed in
 * this slice: no `claude-subscription` account is reserved, API-key profiles
 * resolve only from encrypted `model_protected_secrets` (no ambient fallback; a missing row prepares as
 * `authentication-required`), and a repo image override is refused.
 *
 * No secret reaches a log or a thrown message: failures use fixed text.
 */
import { randomUUID } from "node:crypto";
import type { AgentConfigAdminDeps } from "./admin.js";
import { inspectAgentReadiness, type AgentRunPreparationDeps } from "./agent-run-preparation.js";
import { getDb } from "./dedup.js";
import { getMappings } from "./config.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { getDefaultBranchFileText } from "./github.js";
import type { ModelCredentialDeps } from "./model-credentials.js";
import { createModelProtectedSecrets } from "./model-protected-secrets.js";
import { createModelSessionKeyProvider } from "./model-session-keys.js";
import { createModelSessionOwnership, sessionOwnerVerifier } from "./model-session-ownership.js";
import type { ModelSessionOwnership } from "./model-session-ownership.js";
import { createModelSessionStore } from "./model-session-store.js";
import type { ModelSessionStore } from "./model-session-store.js";
import { resolveSessionImage } from "./repo-image.js";
import type { AppConfig } from "./index.js";

type RuntimeConfig = Pick<AppConfig, "githubAppId" | "githubAppPrivateKey" | "sessionImage">;

export interface ModelAuthRuntime {
  /** Shared with the routes. */
  sessionStore: ModelSessionStore;
  /** Shared with the routes and the adapter. */
  ownership: ModelSessionOwnership;
  credentials: ModelCredentialDeps;
  /** Per-dispatch deps. Every closure is bound to this target repo and project. */
  preparationDeps(target: { owner: string; repo: string; projectKey: string }): AgentRunPreparationDeps;
}

const REPO_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function createModelAuthRuntime(input: {
  config: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): ModelAuthRuntime {
  const { config } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  const sessionStore = createModelSessionStore({
    keys: createModelSessionKeyProvider(input.env),
    verifyOwner: sessionOwnerVerifier,
    authorizeOperator: () => false,
    db: () => getDb(),
  });

  const baseOwnership = createModelSessionOwnership({ store: sessionStore, probe: () => "unknown" });
  const ownership: ModelSessionOwnership = {
    ...baseOwnership,
    reserve(request) {
      const profiles = request?.profiles;
      // Decision 1: no claude-subscription account is reserved in this slice, even if a pre-check misses one.
      if (Array.isArray(profiles) && profiles.some((p) => p?.authMode === "subscription")) {
        return { status: "rejected", reason: "invalid_input" };
      }
      return baseOwnership.reserve(request);
    },
  };

  // API-key and Bedrock secrets come only from encrypted storage keyed off RUNNER_TOKEN_SECRET.
  const credentials: ModelCredentialDeps = {
    sessionStore,
    resolveProtectedSecret: createModelProtectedSecrets({ env: input.env }).resolve,
  };

  /** Installation token narrowed to the one repository being checked. */
  async function token(owner: string, repo: string): Promise<string> {
    try {
      const scoped = await getScopedInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner, {
        repositories: [repo],
      });
      return scoped.token;
    } catch {
      throw new Error("could not obtain a GitHub installation token");
    }
  }

  return {
    sessionStore,
    ownership,
    credentials,
    preparationDeps(target) {
      return {
        ownership,
        credentials,
        // Text at the mapping's branch (the one dispatch runs), else GitHub's default; repo-scoped token. `null` is an absent file; any other failure throws, which
        // preparation reports as `delivery_unreadable` (never as "absent").
        async readDefaultBranchWorkflows(repository, paths) {
          const m = REPO_REF.exec(repository);
          if (!m) throw new Error("malformed repository reference");
          const bearer = await token(m[1]!, m[2]!);
          // One ref for every path, retired ones included. A lookup failure throws (-> delivery_unreadable)
          // rather than falling back to the wrong branch.
          const ref = getMappings()[target.projectKey]?.defaultBranch || undefined;
          const files: Record<string, string | null> = {};
          for (const path of paths) files[path] = await getDefaultBranchFileText(bearer, m[1]!, m[2]!, path, ref);
          return files;
        },
        async checkRunnerCapability(backend) {
          if (backend === "local-docker") return true;
          if (backend !== "fly-machines") return false;
          // Only the paired image is known to run a configured snapshot (run-config.ts).
          const resolved = await resolveSessionImage({
            owner: target.owner,
            repo: target.repo,
            token: await token(target.owner, target.repo),
            defaultImage: config.sessionImage,
            fetchImpl,
          });
          return resolved.source === "default";
        },
      };
    },
  };
}

/** Binds the admin API's readiness seam (AII-962) to the shared runtime. Read-only: it inspects, reserves and mints nothing. */
export function createAgentConfigAdminDeps(config: RuntimeConfig): AgentConfigAdminDeps {
  const runtime = getModelAuthRuntime(config);
  return {
    credentials: runtime.credentials,
    sessionSnapshot: (profileId) => runtime.ownership.snapshot(profileId),
    inspectReadiness(request, candidate) {
      const [owner, repo] = request.workflowRepository.split("/");
      return inspectAgentReadiness(
        { ...request, dispatchId: `admin-readiness-${randomUUID()}` },
        runtime.preparationDeps({ owner: owner!, repo: repo!, projectKey: request.projectKey }),
        candidate,
      );
    },
  };
}

let singleton: ModelAuthRuntime | undefined;

/** First call builds the runtime; later calls return it and ignore `config`. */
export function getModelAuthRuntime(config: RuntimeConfig): ModelAuthRuntime {
  singleton ??= createModelAuthRuntime({ config });
  return singleton;
}

export function __resetModelAuthRuntimeForTests(): void {
  singleton = undefined;
}
