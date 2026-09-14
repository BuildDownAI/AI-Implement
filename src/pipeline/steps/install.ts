import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { repoProcessEnv } from "../process-env.js";
import type { ReviewerDefinition } from "../reviewers/registry.js";
import { REVIEWER_VERDICT_SCHEMA } from "../reviewers/schema.js";

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

interface InstallInputs extends Record<string, unknown> {
  workspaceDir: string;
}

interface InstallOutputs extends Record<string, unknown> {
  packageManager: string;
  installMethod: string;
  durationMs: number;
  repoModels: RepoModels;
  reviewProviders?: string[];
  reviewCheckNames?: string[];
  reviewers?: ReviewerDefinition[];
}

const KNOWN_REVIEW_PROVIDERS = new Set(["github-claude-code-review"]);

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

export const installStep: StepModule<InstallInputs, InstallOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: InstallInputs,
    _reporter: StepReporter,
  ): Promise<InstallOutputs> {
    const { workspaceDir } = inputs;

    const config = readAiImplementConfig(workspaceDir);
    const hasPackageJson = fs.existsSync(path.join(workspaceDir, "package.json"));

    if (process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted") {
      return {
        packageManager: config.packageManager ?? (hasPackageJson ? detectPackageManager(workspaceDir) : "none"),
        installMethod: "skipped: mounted workspace",
        durationMs: 0,
        repoModels: config.models ?? {},
        reviewProviders: config.reviewProviders,
        reviewCheckNames: config.reviewCheckNames,
        reviewers: config.reviewers,
      };
    }

    if (!hasPackageJson) {
      return {
        packageManager: config.packageManager ?? "none",
        installMethod: "skipped: no package.json",
        durationMs: 0,
        repoModels: config.models ?? {},
        reviewProviders: config.reviewProviders,
        reviewCheckNames: config.reviewCheckNames,
        reviewers: config.reviewers,
      };
    }

    const packageManager = config.packageManager ?? detectPackageManager(workspaceDir);
    const installMethod = buildInstallCommand(packageManager);

    const npmAuth = configureNpmAuth();
    const env = repoProcessEnv();
    if (npmAuth) env.NPM_CONFIG_USERCONFIG = npmAuth.userconfigPath;

    const start = Date.now();
    const [cmd, ...cmdArgs] = installMethod.split(/\s+/);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd!, cmdArgs, {
          cwd: workspaceDir,
          stdio: "inherit",
          env,
        });
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${installMethod} exited with code ${code ?? "unknown"}`));
        });
        proc.on("error", reject);
      });
    } finally {
      removeNpmAuth(npmAuth);
    }
    const durationMs = Date.now() - start;

    return {
      packageManager,
      installMethod,
      durationMs,
      repoModels: config.models ?? {},
      reviewProviders: config.reviewProviders,
      reviewCheckNames: config.reviewCheckNames,
      reviewers: config.reviewers,
    };
  },
};
