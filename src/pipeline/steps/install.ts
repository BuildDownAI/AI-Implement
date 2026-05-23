import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function stripYamlComment(value: string): string {
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (char === "#" && quote === null) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function normalizeYamlScalar(value: string): string | undefined {
  const trimmed = stripYamlComment(value);
  if (!trimmed) return undefined;
  const quote = trimmed[0];
  if ((quote === "'" || quote === "\"") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitInlineYamlArrayItems(value: string): string[] | null {
  const trimmed = stripYamlComment(value);
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  const items: string[] = [];
  let quote: "'" | "\"" | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (char === "," && quote === null) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote !== null) return null;
  items.push(inner.slice(start));
  return items;
}

function parseModelsSection(raw: string): RepoModels {
  const result: RepoModels = {};
  const lines = raw.split(/\r?\n/);
  let inModels = false;
  for (const line of lines) {
    if (/^models:/.test(line)) {
      inModels = true;
      continue;
    }
    if (inModels) {
      // A non-empty line starting without indentation means a new top-level key
      if (/^\S/.test(line) && line.trim() !== "") {
        inModels = false;
        continue;
      }
      // Note: quoted YAML values (e.g. implement: "model-name") are not stripped —
      // users should write unquoted values to avoid silently including quote characters.
      const implMatch = /^\s+implement:\s*(\S+)/.exec(line);
      if (implMatch) result.implement = implMatch[1];
      const reviewMatch = /^\s+review:\s*(\S+)/.exec(line);
      if (reviewMatch) result.review = reviewMatch[1];
    }
  }
  return result;
}

function parseReviewProvidersSection(raw: string): string[] | undefined {
  const lines = raw.split(/\r?\n/);
  let inReviewProviders = false;
  const providers: string[] = [];
  let sawReviewProviders = false;
  let sawListItem = false;

  for (const line of lines) {
    const topLevelMatch = /^reviewProviders:\s*(.*)$/.exec(line);
    if (topLevelMatch) {
      const inlineValue = stripYamlComment(topLevelMatch[1] ?? "");
      if (inlineValue) {
        const inlineItems = splitInlineYamlArrayItems(inlineValue);
        if (inlineItems === null) return undefined;
        if (inlineItems.length === 0) return [];
        const knownProviders = inlineItems
          .map((item) => normalizeYamlScalar(item))
          .filter((provider): provider is string =>
            provider !== undefined && KNOWN_REVIEW_PROVIDERS.has(provider),
          );
        return knownProviders.length > 0 ? knownProviders : undefined;
      }
      inReviewProviders = true;
      sawReviewProviders = true;
      continue;
    }
    if (inReviewProviders) {
      if (/^\S/.test(line) && line.trim() !== "") {
        inReviewProviders = false;
        continue;
      }
      const providerMatch = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (providerMatch) sawListItem = true;
      const provider = providerMatch ? normalizeYamlScalar(providerMatch[1]) : undefined;
      if (provider && KNOWN_REVIEW_PROVIDERS.has(provider)) {
        providers.push(provider);
      }
    }
  }

  if (!sawReviewProviders || !sawListItem) return undefined;
  return providers.length > 0 ? providers : undefined;
}

function readAiImplementConfig(workspaceDir: string): AiImplementConfig {
  const configPath = path.join(workspaceDir, ".ai-implement", "config.yml");
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    // Minimal YAML key: value parsing — avoids pulling in a yaml dep
    const pkgMatch = /^packageManager:\s*(\S+)/m.exec(raw);
    const models = parseModelsSection(raw);
    const reviewProviders = parseReviewProvidersSection(raw);
    const config: AiImplementConfig = {};
    if (pkgMatch) config.packageManager = pkgMatch[1];
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
