import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { runConfigFromTaskDocument } from "./run-config.js";
import type { RunConfigV1 } from "./run-config.js";

export type { RunConfigV1 };

const ALLOWED_KEYS = new Set(["title", "id", "base", "profiles", "limits"]);
const ALLOWED_LIMIT_KEYS = new Set(["maxTurns", "maxIterations"]);
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const FIELD_HINTS: Record<string, string> = {
  repo: "Field 'repo' is not allowed (repository path). Pass the repository as a CLI argument, not in the task document.",
  repository:
    "Field 'repository' is not allowed (repository path). Pass the repository as a CLI argument, not in the task document.",
  identifier:
    "Field 'identifier' is not allowed. Use 'id' to set a task identifier:\n  id: DEV-42",
  branch:
    "Field 'branch' is not allowed (publication setting). Use 'base' for a git ref:\n  base: main",
  maxTurns:
    "Field 'maxTurns' is not allowed at the top level. Move it into a limits block:\n  limits:\n    maxTurns: 50",
  maxIterations:
    "Field 'maxIterations' is not allowed at the top level. Move it into a limits block:\n  limits:\n    maxIterations: 3",
  token:
    "Field 'token' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  apiKey:
    "Field 'apiKey' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  apikey:
    "Field 'apikey' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  anthropicApiKey:
    "Field 'anthropicApiKey' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  githubToken:
    "Field 'githubToken' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  secret:
    "Field 'secret' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
  credentials:
    "Field 'credentials' is not allowed (credential). Pass credentials as environment variables or CLI arguments.",
};

const SCHEMA_EXAMPLE = [
  "  title: Required task title",
  "  id: DEV-42             # optional",
  "  base: main             # optional git ref",
  "  profiles:              # optional",
  "    - backend",
  "  limits:                # optional",
  "    maxTurns: 50",
  "    maxIterations: 3",
].join("\n");

/**
 * Parse a portable YAML-front-matter Markdown task document and return a
 * RunConfigV1 suitable for local execution.
 *
 * Schema (strict — unknown fields are rejected):
 *   title:    string          required
 *   id:       string          optional, non-empty; maps to issue.identifier
 *   base:     string          optional, git ref; maps to baseBranch
 *   profiles: string[]        optional, non-empty unique values
 *   limits:
 *     maxTurns:      positive integer  optional
 *     maxIterations: positive integer  optional
 *
 * The Markdown body becomes issue.description. Repository paths, credentials,
 * publication settings, and queue-dependency fields are explicitly rejected.
 */
export function parseTaskDocument(content: string, issueId?: string): RunConfigV1 {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) {
    throw new Error(
      "Task document must begin with a YAML front matter block delimited by ---.\n" +
        "Example:\n---\ntitle: My task\n---\n\nTask description.",
    );
  }
  const [, yamlBlock, body] = match;

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(yamlBlock);
    fm =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch (err) {
    throw new Error(
      `Task document front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof fm.title !== "string" || !fm.title.trim()) {
    throw new Error(
      "Field 'title' is required and must be a non-empty string.\nExample:\n  title: Implement login page",
    );
  }

  for (const key of Object.keys(fm)) {
    if (ALLOWED_KEYS.has(key)) continue;
    const hint = FIELD_HINTS[key];
    if (hint) throw new Error(hint);
    throw new Error(
      `Field '${key}' is not recognized in a task document.\nAllowed fields:\n${SCHEMA_EXAMPLE}`,
    );
  }

  if (fm.id !== undefined && (typeof fm.id !== "string" || !fm.id.trim())) {
    throw new Error("Field 'id' must be a non-empty string.\nExample:\n  id: DEV-42");
  }

  if (fm.base !== undefined && (typeof fm.base !== "string" || !fm.base.trim())) {
    throw new Error(
      "Field 'base' must be a non-empty string (git ref).\nExample:\n  base: main",
    );
  }

  if (fm.profiles !== undefined) {
    if (!Array.isArray(fm.profiles) || fm.profiles.length === 0) {
      throw new Error(
        "Field 'profiles' must be a non-empty list of strings.\nExample:\n  profiles:\n    - backend",
      );
    }
    for (const p of fm.profiles) {
      if (typeof p !== "string" || !(p as string).trim()) {
        throw new Error(
          "Field 'profiles' must contain only non-empty strings.\n" +
            "Example:\n  profiles:\n    - backend\n    - webapp",
        );
      }
    }
    const seen = new Set<string>();
    for (const p of fm.profiles as string[]) {
      if (seen.has(p)) {
        throw new Error(
          `Field 'profiles' contains duplicate value '${p}'. Values must be unique.\n` +
            "Example:\n  profiles:\n    - backend\n    - webapp",
        );
      }
      seen.add(p);
    }
  }

  let maxTurns: number | undefined;
  let maxIterations: number | undefined;

  if (fm.limits !== undefined) {
    if (typeof fm.limits !== "object" || fm.limits === null || Array.isArray(fm.limits)) {
      throw new Error(
        "Field 'limits' must be an object.\nExample:\n  limits:\n    maxTurns: 50\n    maxIterations: 3",
      );
    }
    const limits = fm.limits as Record<string, unknown>;
    for (const key of Object.keys(limits)) {
      if (!ALLOWED_LIMIT_KEYS.has(key)) {
        throw new Error(
          `Field 'limits.${key}' is not recognized.\n` +
            "Allowed limit fields: maxTurns, maxIterations.\n" +
            "Example:\n  limits:\n    maxTurns: 50\n    maxIterations: 3",
        );
      }
    }
    if (limits.maxTurns !== undefined) {
      if (!isPositiveInt(limits.maxTurns)) {
        throw new Error(
          "Field 'limits.maxTurns' must be a positive integer.\nExample:\n  limits:\n    maxTurns: 50",
        );
      }
      maxTurns = limits.maxTurns as number;
    }
    if (limits.maxIterations !== undefined) {
      if (!isPositiveInt(limits.maxIterations)) {
        throw new Error(
          "Field 'limits.maxIterations' must be a positive integer.\nExample:\n  limits:\n    maxIterations: 3",
        );
      }
      maxIterations = limits.maxIterations as number;
    }
  }

  return runConfigFromTaskDocument(
    {
      title: fm.title.trim(),
      description: body.trim(),
      identifier: typeof fm.id === "string" ? fm.id.trim() : undefined,
      baseBranch: typeof fm.base === "string" ? fm.base.trim() : undefined,
      profiles: fm.profiles as string[] | undefined,
      maxTurns,
      maxIterations,
    },
    issueId ?? randomUUID(),
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
