import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import type { ReviewerSelection } from "../../config.js";
import { repoProcessEnv } from "../process-env.js";
import { resolveTrustedReviewer, type ReviewerDefinition } from "../reviewers/registry.js";
import { REVIEWER_VERDICT_SCHEMA } from "../reviewers/schema.js";
import { redactAndCap } from "../failure-classification.js";

interface RepoModels {
  implement?: string;
  review?: string;
}

interface AiImplementConfig {
  packageManager?: string;
  models?: RepoModels;
  reviewProviders?: string[];
  reviewCheckNames?: string[];
  reviewers?: ReviewerDefinition[];
}

interface TrustedConfigReviewersInput {
  owner?: string;
  repo?: string;
  token?: string;
  reviewers?: ReviewerSelection[];
  trustedReviewerDefinitions?: ReadonlyMap<string, ReviewerDefinition>;
  fetchImpl?: typeof fetch;
}

interface InstallInputs extends Record<string, unknown> {
  workspaceDir: string;
  fetchImpl?: typeof fetch;
  /** Second-attempt mode: reuses the first attempt's packageManager and skips config reads. */
  retry?: boolean;
  packageManager?: string;
}

interface InstallOutputs extends Record<string, unknown> {
  packageManager: string;
  installMethod: string;
  durationMs: number;
  installFailed: boolean;
  /** Tail of the install output, redacted and capped, set only when installFailed is true. */
  installError?: string;
  /** Omitted in retry mode — downstream steps read config only from the first "install" step id. */
  repoModels?: RepoModels;
  reviewProviders?: string[];
  reviewCheckNames?: string[];
  reviewers?: ReviewerDefinition[];
  trustedConfigReviewers?: ReviewerDefinition[];
}

const KNOWN_REVIEW_PROVIDERS = new Set(["github-claude-code-review"]);
const RESERVED_CONFIG_REVIEWER_IDS = new Set(["claude-review-summary", "legacy-post-push-review"]);
const CONFIG_PATH = ".ai-implement/config.yml";
const TRUSTED_CONFIG_FETCH_TIMEOUT_MS = 15_000;

function parseModelsConfig(value: unknown): RepoModels {
  const result: RepoModels = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const models = value as Record<string, unknown>;
  if (typeof models.implement === "string" && models.implement.trim()) {
    result.implement = models.implement.trim();
  }
  if (typeof models.review === "string" && models.review.trim()) {
    result.review = models.review.trim();
  }
  return result;
}

export function parseReviewCheckNamesConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  return names.length > 0 ? names : undefined;
}

function parseReviewProvidersConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const providers = value.filter((provider): provider is string =>
    typeof provider === "string" && KNOWN_REVIEW_PROVIDERS.has(provider),
  );
  return providers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `.ai-implement/config.yml` is read from the PR workspace, so reviewer declarations
 * are prompt data only: they never carry gates, a schema, or an executable override.
 * Built-in and image-baked reviewer definitions must win during integration; otherwise
 * a PR could replace `gap-analysis` with a prompt that approves itself.
 */
export function parseReviewersConfig(value: unknown): ReviewerDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.warn("[install] Ignoring invalid reviewers config; expected an array");
    return undefined;
  }

  const reviewers: ReviewerDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      console.warn(`[install] Ignoring invalid reviewers[${index}] config; expected an object`);
      continue;
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
    if (!id || !prompt.trim()) {
      console.warn(`[install] Ignoring invalid reviewers[${index}] config; id and prompt are required`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[install] Ignoring invalid reviewers[${index}] config; duplicate id "${id}"`);
      continue;
    }
    seen.add(id);

    const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined;
    reviewers.push({
      id,
      buildPrompt: () => prompt,
      outputSchema: REVIEWER_VERDICT_SCHEMA,
      ...(model ? { model } : {}),
    });
  }

  return reviewers.length > 0 ? reviewers : undefined;
}

function readAiImplementConfig(workspaceDir: string): AiImplementConfig {
  const configPath = path.join(workspaceDir, ".ai-implement", "config.yml");
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const doc = parsed as Record<string, unknown>;
    const models = parseModelsConfig(doc.models);
    const reviewProviders = parseReviewProvidersConfig(doc.reviewProviders);
    const reviewCheckNames = parseReviewCheckNamesConfig(doc.reviewCheckNames);
    const reviewers = parseReviewersConfig(doc.reviewers);
    const config: AiImplementConfig = {};
    if (typeof doc.packageManager === "string" && doc.packageManager.trim()) {
      config.packageManager = doc.packageManager.trim();
    }
    if (models.implement || models.review) config.models = models;
    if (reviewProviders !== undefined) config.reviewProviders = reviewProviders;
    if (reviewCheckNames !== undefined) config.reviewCheckNames = reviewCheckNames;
    if (reviewers !== undefined) config.reviewers = reviewers;
    return config;
  } catch {
    return {};
  }
}

async function selectedGatingConfigReviewerIds(input: TrustedConfigReviewersInput): Promise<string[]> {
  const trustedIds = new Set(input.trustedReviewerDefinitions?.keys() ?? []);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const selection of input.reviewers ?? []) {
    if (!selection.gates) continue;
    if (RESERVED_CONFIG_REVIEWER_IDS.has(selection.id)) continue;
    if (trustedIds.has(selection.id)) continue;
    if (seen.has(selection.id)) continue;
    const trustedReviewer = await resolveTrustedReviewer(selection.id, { quietMissing: true });
    if (trustedReviewer) continue;
    seen.add(selection.id);
    ids.push(selection.id);
  }
  return ids;
}

function trustedConfigWarning(repoSlug: string, message: string): void {
  console.warn(`[install] Trusted reviewer config unavailable for ${repoSlug}: ${message}`);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function readGithubContentsText(input: {
  owner: string;
  repo: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const { owner, repo, token, fetchImpl } = input;
  const repoSlug = `${owner}/${repo}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${CONFIG_PATH}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-implement-runner",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TRUSTED_CONFIG_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    trustedConfigWarning(repoSlug, "fetch failed");
    return null;
  }

  if (res.status === 404) {
    trustedConfigWarning(repoSlug, `${CONFIG_PATH} not found on the default branch`);
    return null;
  }
  if (!res.ok) {
    trustedConfigWarning(repoSlug, `${CONFIG_PATH} lookup returned HTTP ${res.status}`);
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    trustedConfigWarning(repoSlug, `${CONFIG_PATH} response was not JSON`);
    return null;
  }

  if (!isRecord(body) || body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
    trustedConfigWarning(repoSlug, `${CONFIG_PATH} was not a file blob`);
    return null;
  }

  try {
    return Buffer.from(body.content, "base64").toString("utf8");
  } catch {
    trustedConfigWarning(repoSlug, `${CONFIG_PATH} content was not valid base64`);
    return null;
  }
}

export async function fetchTrustedConfigReviewers(input: TrustedConfigReviewersInput): Promise<ReviewerDefinition[]> {
  const selectedIds = await selectedGatingConfigReviewerIds(input);
  if (selectedIds.length === 0) return [];

  const { owner, repo, token } = input;
  if (!owner || !repo || !token) {
    trustedConfigWarning(`${owner || "unknown"}/${repo || "unknown"}`, `missing GitHub context for selected reviewer(s): ${selectedIds.join(", ")}`);
    return [];
  }

  const text = await readGithubContentsText({ owner, repo, token, fetchImpl: input.fetchImpl ?? fetch });
  if (text === null) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch {
    trustedConfigWarning(`${owner}/${repo}`, `${CONFIG_PATH} was malformed YAML`);
    return [];
  }
  if (!isRecord(parsed)) {
    trustedConfigWarning(`${owner}/${repo}`, `${CONFIG_PATH} did not contain a config object`);
    return [];
  }

  const definitions = parseReviewersConfig(parsed.reviewers) ?? [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const selectedSet = new Set(selectedIds);
  const selectedDefinitions = definitions.filter((definition) => selectedSet.has(definition.id));
  const missing = selectedIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    trustedConfigWarning(`${owner}/${repo}`, `${CONFIG_PATH} lacks selected reviewer(s): ${missing.join(", ")}`);
  }
  return selectedDefinitions;
}

interface NpmAuthConfig {
  /** Temp directory holding the per-run user config; removed after install. */
  dir: string;
  /** Path handed to the install process as NPM_CONFIG_USERCONFIG. */
  userconfigPath: string;
}

/**
 * Private-registry auth for the install step.
 *
 * The token is read from NPM_TOKEN, which reaches the runner through the
 * forwarded-secrets rail (AI_IMPLEMENT_FORWARDED_ENV on GHA, a team-prefixed
 * secret on Fly) and is therefore stripped from the model process by
 * modelProcessEnv(). The registry and optional scope(s) are plain Actions
 * variables. This lives in the install step rather than a setup hook because
 * install runs BEFORE setup, so a hook cannot supply credentials in time.
 *
 * The credentials are written to a temporary user config selected via
 * NPM_CONFIG_USERCONFIG for the install process only — never to ~/.npmrc —
 * and the file is removed once install finishes, so the token is not left on
 * disk for the model process to read.
 */
function configureNpmAuth(): NpmAuthConfig | undefined {
  const token = process.env.NPM_TOKEN;
  const registry = process.env.AI_IMPLEMENT_NPM_REGISTRY;
  if (!token || !registry) return undefined;

  const normalizedRegistry = registry.endsWith("/") ? registry : `${registry}/`;
  const authHost = normalizedRegistry.replace(/^https?:/, "");
  const lines = [`${authHost}:_authToken=${token}`];

  const scopes = (process.env.AI_IMPLEMENT_NPM_SCOPE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const scope of scopes) {
    const name = scope.startsWith("@") ? scope : `@${scope}`;
    lines.push(`${name}:registry=${normalizedRegistry}`);
  }

  // NPM_CONFIG_USERCONFIG replaces ~/.npmrc rather than layering on it, so
  // carry any existing user config forward instead of shadowing it.
  const homeNpmrc = path.join(os.homedir(), ".npmrc");
  const existing = fs.existsSync(homeNpmrc) ? fs.readFileSync(homeNpmrc, "utf-8") : "";
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-implement-npmrc-"));
  const userconfigPath = path.join(dir, ".npmrc");
  fs.writeFileSync(userconfigPath, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
  return { dir, userconfigPath };
}

function removeNpmAuth(auth: NpmAuthConfig | undefined): void {
  if (!auth) return;
  fs.rmSync(auth.dir, { recursive: true, force: true });
}

function detectPackageManager(workspaceDir: string): string {
  if (fs.existsSync(path.join(workspaceDir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(workspaceDir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function buildInstallCommand(packageManager: string): string {
  if (packageManager === "yarn") return "yarn install --frozen-lockfile";
  if (packageManager === "pnpm") return "pnpm install --frozen-lockfile";
  if (packageManager === "none") {
    throw new Error("buildInstallCommand called with packageManager=none");
  }
  return "npm ci";
}

/** Combined stdout+stderr tail retained for `installError` — long enough to catch the cause
 *  npm/yarn/pnpm print at the end (ERESOLVE, the peer-conflict tree), short enough that it
 *  never dominates the agent prompt or step_log. */
const INSTALL_TAIL_CHARS = 4096;

function makeTailCollector(limit: number) {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      if (buffer.length > limit) buffer = buffer.slice(buffer.length - limit);
    },
    get value(): string {
      return buffer;
    },
  };
}

interface SpawnInstallResult {
  durationMs: number;
  installFailed: boolean;
  installError?: string;
}

/**
 * Retry mode always follows a failed first attempt (install-retry's skip condition
 * guarantees that), so this reports the retry's own outcome without re-checking the
 * first attempt. Comments are posted in filename order; 70- sorts ahead of the 80-
 * reviewer-feedback and 90-/95- run-autopsy/run-stats files.
 */
function writeDependencyInstallComment(
  workspaceDir: string,
  installMethod: string,
  result: SpawnInstallResult,
): void {
  const body = result.installFailed
    ? [
        `Dependency install (\`${installMethod}\`) failed before and after the agent ran. Build and tests did not run.`,
        "",
        "```",
        result.installError ?? "(no output captured)",
        "```",
      ].join("\n")
    : `Dependency install (\`${installMethod}\`) failed before the agent ran and succeeded after its change.`;
  try {
    const commentsDir = path.join(workspaceDir, "ai-output", "comments");
    fs.mkdirSync(commentsDir, { recursive: true });
    fs.writeFileSync(path.join(commentsDir, "70-dependency-install.md"), body, "utf-8");
  } catch (err) {
    console.warn(`[install] could not write dependency install comment file (non-fatal): ${String(err)}`);
  }
}

/**
 * Runs `installMethod` in `workspaceDir`, streaming stdout/stderr through to the process
 * streams (so live log tailing is unaffected) while keeping a rolling tail for `installError`.
 * Never rejects: a non-zero exit or a spawn `error` event both resolve with `installFailed: true`
 * so the pipeline can continue without dependencies rather than aborting the run.
 */
async function runInstallCommand(
  workspaceDir: string,
  installMethod: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnInstallResult> {
  const [cmd, ...cmdArgs] = installMethod.split(/\s+/);
  const tail = makeTailCollector(INSTALL_TAIL_CHARS);
  const start = Date.now();

  const outcome = await new Promise<{ ok: true } | { ok: false; detail: string }>((resolve) => {
    const proc = spawn(cmd!, cmdArgs, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    proc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      tail.push(chunk.toString("utf-8"));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail.push(chunk.toString("utf-8"));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: `${installMethod} exited with code ${code ?? "unknown"}` });
    });
    proc.on("error", (err) => {
      resolve({ ok: false, detail: `${installMethod} failed to start: ${err.message}` });
    });
  });

  const durationMs = Date.now() - start;
  if (outcome.ok) return { durationMs, installFailed: false };

  tail.push(`\n${outcome.detail}`);
  console.warn(`[install] ${installMethod} failed; continuing without dependencies`);
  return { durationMs, installFailed: true, installError: redactAndCap(tail.value, INSTALL_TAIL_CHARS) };
}

export const installStep: StepModule<InstallInputs, InstallOutputs> = {
  async run(
    context: PipelineContext,
    inputs: InstallInputs,
    _reporter: StepReporter,
  ): Promise<InstallOutputs> {
    const { workspaceDir } = inputs;

    if (inputs.retry) {
      const packageManager = inputs.packageManager ?? "npm";
      const installMethod = buildInstallCommand(packageManager);
      const npmAuth = configureNpmAuth();
      const env = repoProcessEnv();
      if (npmAuth) env.NPM_CONFIG_USERCONFIG = npmAuth.userconfigPath;
      let result: SpawnInstallResult;
      try {
        result = await runInstallCommand(workspaceDir, installMethod, env);
      } finally {
        removeNpmAuth(npmAuth);
      }
      writeDependencyInstallComment(workspaceDir, installMethod, result);
      return {
        packageManager,
        installMethod,
        durationMs: result.durationMs,
        installFailed: result.installFailed,
        ...(result.installError !== undefined ? { installError: result.installError } : {}),
      };
    }

    const config = readAiImplementConfig(workspaceDir);
    const cloneOutputs = context.getOutputs("clone");
    const trustedConfigReviewers = await fetchTrustedConfigReviewers({
      owner: optionalString(cloneOutputs.repoOwner) ?? context.data.githubOwner,
      repo: optionalString(cloneOutputs.repoRepo) ?? context.data.githubRepo,
      token: optionalString(cloneOutputs.githubToken) ?? context.data.githubToken,
      reviewers: context.data.reviewers,
      trustedReviewerDefinitions: context.data.trustedReviewerDefinitions,
      fetchImpl: inputs.fetchImpl,
    });
    const hasPackageJson = fs.existsSync(path.join(workspaceDir, "package.json"));

    const configOutputs = {
      repoModels: config.models ?? {},
      reviewProviders: config.reviewProviders,
      reviewCheckNames: config.reviewCheckNames,
      reviewers: config.reviewers,
      trustedConfigReviewers,
    };

    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      return {
        packageManager: config.packageManager ?? (hasPackageJson ? detectPackageManager(workspaceDir) : "none"),
        installMethod: "skipped: mounted workspace",
        durationMs: 0,
        installFailed: false,
        ...configOutputs,
      };
    }

    if (!hasPackageJson) {
      return {
        packageManager: config.packageManager ?? "none",
        installMethod: "skipped: no package.json",
        durationMs: 0,
        installFailed: false,
        ...configOutputs,
      };
    }

    const packageManager = config.packageManager ?? detectPackageManager(workspaceDir);
    if (packageManager === "none") {
      return {
        packageManager,
        installMethod: "skipped: packageManager none",
        durationMs: 0,
        installFailed: false,
        ...configOutputs,
      };
    }

    const installMethod = buildInstallCommand(packageManager);
    const npmAuth = configureNpmAuth();
    const env = repoProcessEnv();
    if (npmAuth) env.NPM_CONFIG_USERCONFIG = npmAuth.userconfigPath;

    let result: SpawnInstallResult;
    try {
      result = await runInstallCommand(workspaceDir, installMethod, env);
    } finally {
      removeNpmAuth(npmAuth);
    }

    return {
      packageManager,
      installMethod,
      durationMs: result.durationMs,
      installFailed: result.installFailed,
      ...(result.installError !== undefined ? { installError: result.installError } : {}),
      ...configOutputs,
    };
  },
};
