/**
 * Production composition of the model-auth dependencies (AII-1385) that `prepareAgentRun` and the model-auth
 * routes need. No consumer exists yet; later leaves of AII-958 wire it into dispatch.
 *
 * Every store here is a stateless wrapper over `getDb()`, so one process-wide instance is safe. Rules fixed in
 * this slice: no `claude-subscription` account is reserved, no GitHub Actions path prepares, API-key profiles
 * resolve no secret (they prepare as `authentication-required`), and a repo image override is refused.
 *
 * No secret reaches a log or a thrown message: failures use fixed text.
 */
import { getProjectOptIn } from "./agent-config-store.js";
import type { AgentRunPreparationDeps } from "./agent-run-preparation.js";
import { getDb } from "./dedup.js";
import { getInstallationToken } from "./github-app-auth.js";
import type { ModelCredentialDeps } from "./model-credentials.js";
import { createModelSessionKeyProvider } from "./model-session-keys.js";
import { createModelSessionOwnership, sessionOwnerVerifier } from "./model-session-ownership.js";
import type { ModelSessionOwnership } from "./model-session-ownership.js";
import { createModelSessionStore } from "./model-session-store.js";
import type { ModelSessionStore } from "./model-session-store.js";
import { resolveSessionImage } from "./repo-image.js";
import type { RepoTrust, RepoVisibility } from "./repo-trust.js";
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

const VISIBILITIES: readonly RepoVisibility[] = ["public", "private", "internal"];
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

  // Operator decision: no new secrets. An API-key profile prepares as authentication-required.
  const credentials: ModelCredentialDeps = { sessionStore, resolveProtectedSecret: () => null };

  async function token(owner: string): Promise<string> {
    try {
      return await getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner);
    } catch {
      throw new Error("could not obtain a GitHub installation token");
    }
  }

  async function fetchVisibility(repository: string): Promise<RepoVisibility> {
    const m = REPO_REF.exec(repository);
    if (!m) throw new Error("malformed repository reference");
    const bearer = await token(m[1]!);
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "linear-dispatch-worker",
          Authorization: `Bearer ${bearer}`,
        },
        signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS) || 60_000),
      });
    } catch {
      throw new Error("repository visibility fetch failed");
    }
    if (!res.ok) throw new Error(`repository visibility fetch returned HTTP ${res.status}`);
    let data: { visibility?: unknown };
    try {
      data = (await res.json()) as { visibility?: unknown };
    } catch {
      throw new Error("repository visibility response was not JSON");
    }
    const v = data.visibility;
    if (typeof v !== "string" || !VISIBILITIES.includes(v as RepoVisibility)) {
      throw new Error("repository visibility missing or unrecognised");
    }
    return v as RepoVisibility;
  }

  return {
    sessionStore,
    ownership,
    credentials,
    preparationDeps(target) {
      return {
        ownership,
        credentials,
        async getRepoTrust(repository): Promise<RepoTrust> {
          const visibility = await fetchVisibility(repository);
          return { visibility, trustedForSubscription: visibility === "private" && getProjectOptIn(target.projectKey) };
        },
        // No GitHub Actions path prepares in this slice; a resolving stub would be a silent pass.
        readDefaultBranchWorkflows() {
          return Promise.reject(new Error("GitHub Actions workflows are not readable in this slice"));
        },
        async checkRunnerCapability(backend) {
          if (backend === "local-docker") return true;
          if (backend !== "fly-machines") return false;
          // Only the paired image is known to run a configured snapshot (run-config.ts).
          const resolved = await resolveSessionImage({
            owner: target.owner,
            repo: target.repo,
            token: await token(target.owner),
            defaultImage: config.sessionImage,
            fetchImpl,
          });
          return resolved.source === "default";
        },
      };
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
