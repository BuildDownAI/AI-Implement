import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface RepoModels {
  implement?: string;
  review?: string;
}

interface AiImplementConfig {
  packageManager?: string;
  models?: RepoModels;
  reviewProviders?: string[];
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

function parseReviewProvidersConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const providers = value.filter((provider): provider is string =>
    typeof provider === "string" && KNOWN_REVIEW_PROVIDERS.has(provider),
  );
  return providers;
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
    const config: AiImplementConfig = {};
    if (typeof doc.packageManager === "string" && doc.packageManager.trim()) {
      config.packageManager = doc.packageManager.trim();
    }
    if (models.implement || models.review) config.models = models;
    if (reviewProviders !== undefined) config.reviewProviders = reviewProviders;
    return config;
  } catch {
    return {};
  }
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

    if (!hasPackageJson) {
      return {
        packageManager: config.packageManager ?? "none",
        installMethod: "skipped: no package.json",
        durationMs: 0,
        repoModels: config.models ?? {},
        reviewProviders: config.reviewProviders,
      };
    }

    const packageManager = config.packageManager ?? detectPackageManager(workspaceDir);
    const installMethod = buildInstallCommand(packageManager);

    const start = Date.now();
    const [cmd, ...cmdArgs] = installMethod.split(/\s+/);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd!, cmdArgs, {
        cwd: workspaceDir,
        stdio: "inherit",
        env: { ...process.env },
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${installMethod} exited with code ${code ?? "unknown"}`));
      });
      proc.on("error", reject);
    });
    const durationMs = Date.now() - start;

    return {
      packageManager,
      installMethod,
      durationMs,
      repoModels: config.models ?? {},
      reviewProviders: config.reviewProviders,
    };
  },
};
