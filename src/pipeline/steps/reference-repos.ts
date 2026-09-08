import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { normalizeReferenceRepos, type ReferenceRepo, type ReferenceRepoResult, type ReferenceRepoResultCause } from "../../reference-repos.js";
import { appendExcludePaths } from "../scratch-exclude.js";

export type SpawnSyncFn = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts?: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

const SHA_RE = /^[0-9a-f]{40}$/i;

interface ReferenceReposInputs extends Record<string, unknown> {
  referenceRepos: ReferenceRepo[] | undefined;
  callbackUrl: string | null | undefined;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test-only injectable spawnSync implementation. */
  spawnSyncImpl?: SpawnSyncFn;
}

interface ReferenceReposOutputs extends Record<string, unknown> {
  results: ReferenceRepoResult[];
}

interface ReferenceTokenOwnerEntry {
  owner: string;
  token: string | null;
  expiresAt: string | null;
  authMode: "installation" | "public" | "error";
}

async function fetchReferenceTokens(params: {
  callbackBase: string;
  progressToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ReferenceTokenOwnerEntry[]> {
  const { callbackBase, progressToken, fetchImpl: fetchFn = fetch } = params;
  const url = `${callbackBase.replace(/\/+$/, "")}/api/runner/reference-token`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${progressToken}` },
  });
  if (!res.ok) {
    throw new Error(`reference-token endpoint returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).owners)) {
    throw new Error("reference-token response missing owners array");
  }
  return (body as { owners: ReferenceTokenOwnerEntry[] }).owners;
}

function ownerFromRepo(repoUrl: string): string {
  const url = new URL(repoUrl);
  return url.pathname.replace(/^\//, "").split("/")[0] ?? "";
}

function cloneRepo(params: {
  repoUrl: string;
  destPath: string;
  ref: string | undefined;
  token: string | null;
  workspaceDir: string;
  spawnSyncImpl: SpawnSyncFn;
}): { success: boolean; cause?: ReferenceRepoResultCause } {
  const { repoUrl, destPath, ref, token, workspaceDir, spawnSyncImpl: spawnFn } = params;
  const absDest = path.join(workspaceDir, destPath);

  // Build the env for the clone — credential via GIT_CONFIG_* env vars so it never
  // persists into the clone's .git/config or remote.origin.url.
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const credEnv = token
    ? {
        ...baseEnv,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : baseEnv;

  const isSha = ref && SHA_RE.test(ref);

  if (isSha) {
    // SHA pin: git init → fetch --depth 1 <url> <sha> → checkout FETCH_HEAD.
    // Fetching by URL adds no origin remote, so nothing about the source persists in the clone.
    const initResult = spawnFn("git", ["init", absDest], {
      stdio: ["ignore", "pipe", "pipe"],
      env: credEnv,
      timeout: 30_000,
    });
    if ((initResult.status ?? 1) !== 0) {
      return { success: false, cause: "clone-error" };
    }

    const fetchResult = spawnFn(
      "git",
      ["fetch", "--depth", "1", repoUrl, ref],
      {
        cwd: absDest,
        stdio: ["ignore", "pipe", "pipe"],
        env: credEnv,
        timeout: 120_000,
      },
    );
    if ((fetchResult.status ?? 1) !== 0) {
      const stderr = fetchResult.stderr?.toString() ?? "";
      const timedOut = (fetchResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      if (timedOut || stderr.includes("couldn't find remote ref")) {
        return { success: false, cause: "ref-not-found" };
      }
      if (stderr.includes("Repository not found") || stderr.includes("could not read Username")) {
        return { success: false, cause: "no-auth" };
      }
      return { success: false, cause: "clone-error" };
    }

    const checkoutResult = spawnFn("git", ["checkout", "FETCH_HEAD"], {
      cwd: absDest,
      stdio: ["ignore", "pipe", "pipe"],
      env: credEnv,
      timeout: 30_000,
    });
    if ((checkoutResult.status ?? 1) !== 0) {
      return { success: false, cause: "clone-error" };
    }

    return { success: true };
  }

  // Branch/tag or default branch
  const args = ref
    ? ["clone", "--depth", "1", "--branch", ref, repoUrl, absDest]
    : ["clone", "--depth", "1", repoUrl, absDest];

  const cloneResult = spawnFn("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: credEnv,
    timeout: 120_000,
  });

  if ((cloneResult.status ?? 1) !== 0) {
    const stderr = cloneResult.stderr?.toString() ?? "";
    const timedOut = (cloneResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (timedOut) {
      return { success: false, cause: "clone-error" };
    }
    if (ref && (stderr.includes("Remote branch") || stderr.includes("not found in upstream"))) {
      return { success: false, cause: "ref-not-found" };
    }
    if (stderr.includes("Repository not found") || stderr.includes("could not read Username")) {
      return { success: false, cause: "no-auth" };
    }
    return { success: false, cause: "clone-error" };
  }

  return { success: true };
}

export const referenceReposStep: StepModule<ReferenceReposInputs, ReferenceReposOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: ReferenceReposInputs,
    _reporter: StepReporter,
  ): Promise<ReferenceReposOutputs> {
    const { referenceRepos, callbackUrl, fetchImpl, spawnSyncImpl: spawnFn = spawnSync as SpawnSyncFn } = inputs;

    if (!referenceRepos || referenceRepos.length === 0) {
      console.log("[reference-repos] no entries configured; skipping");
      return { results: [] };
    }

    // Read the bearer secret directly from the environment so it never appears
    // in step inputs, which are persisted to the step log and served by the admin API.
    const progressToken = process.env.RUN_PROGRESS_TOKEN?.trim() || null;

    if (!progressToken) {
      console.log("[reference-repos] no progress token (RUN_PROGRESS_TOKEN); skipping");
      return { results: [] };
    }
    if (!callbackUrl) {
      console.log("[reference-repos] no callback URL; skipping");
      return { results: [] };
    }

    // Re-validate against current rules — a value stored before a rule tightened is still
    // in the database, and this is the moment it becomes a filesystem operation.
    const results: ReferenceRepoResult[] = [];
    const validatedRepos: ReferenceRepo[] = [];
    const seenPaths = new Set<string>();

    for (const entry of referenceRepos) {
      let normalized: ReferenceRepo | undefined;
      try {
        // One entry at a time: a batch call rejects the whole array on the first bad entry,
        // discarding every valid sibling and reporting nothing about any of them.
        normalized = normalizeReferenceRepos([entry])?.[0];
      } catch (err) {
        console.warn(
          `[reference-repos] rejecting ${entry.repo} → ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!normalized) {
        results.push({ ...entry, arrived: false, cause: "path-invalid" });
        continue;
      }
      // Uniqueness is a cross-entry rule a per-entry call cannot see, so re-apply it here.
      if (seenPaths.has(normalized.path)) {
        console.warn(`[reference-repos] rejecting duplicate path "${normalized.path}" (${normalized.repo})`);
        results.push({ ...normalized, arrived: false, cause: "path-invalid" });
        continue;
      }
      seenPaths.add(normalized.path);
      validatedRepos.push(normalized);
    }

    if (validatedRepos.length === 0) {
      console.log("[reference-repos] no valid entries after re-validation");
      return { results };
    }

    const workspaceDir = process.env.WORKSPACE_DIR ?? "/workspace";

    // Fetch per-owner tokens from the orchestrator.
    let ownerTokens: Map<string, ReferenceTokenOwnerEntry>;
    try {
      const entries = await fetchReferenceTokens({
        callbackBase: callbackUrl,
        progressToken,
        fetchImpl,
      });
      ownerTokens = new Map(entries.map((e) => [e.owner, e]));
    } catch (err) {
      console.warn(
        `[reference-repos] failed to fetch tokens: ${err instanceof Error ? err.message : String(err)}; proceeding without credentials`,
      );
      ownerTokens = new Map();
    }

    for (const entry of validatedRepos) {
      const owner = ownerFromRepo(entry.repo);
      const ownerEntry = ownerTokens.get(owner);

      if (ownerEntry?.authMode === "error") {
        console.warn(`[reference-repos] token mint failed for owner "${owner}" (${entry.repo}); skipping`);
        results.push({ ...entry, arrived: false, cause: "token-error" });
        continue;
      }

      const token = ownerEntry?.token ?? null;

      const { success, cause } = cloneRepo({
        repoUrl: entry.repo,
        destPath: entry.path,
        ref: entry.ref,
        token,
        workspaceDir,
        spawnSyncImpl: spawnFn,
      });

      if (success) {
        appendExcludePaths(workspaceDir, [entry.path]);
        console.log(
          `[reference-repos] cloned ${entry.repo} → ${entry.path}` +
            (entry.ref ? ` @ ${entry.ref}` : " (default branch)"),
        );
        results.push({ ...entry, arrived: true });
      } else {
        console.warn(
          `[reference-repos] failed to clone ${entry.repo} → ${entry.path}: cause=${cause ?? "unknown"}`,
        );
        results.push({ ...entry, arrived: false, cause });
      }
    }

    return { results };
  },
};
