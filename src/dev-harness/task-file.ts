import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface ParsedTaskFile {
  identifier: string;
  title: string;
  description: string;
  maxTurns: number | undefined;
  maxIterations: number | undefined;
  /** owner/repo; undefined = auto-detect from git remote. */
  repo: string | undefined;
  /** Base branch; undefined = auto-detect from current HEAD. */
  branch: string | undefined;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a task file (YAML front matter + markdown body) used as a tracker-free
 * ticket for the local dev harness.
 *
 * Required front matter: `title`
 * Optional front matter: `identifier`, `maxTurns`, `maxIterations`, `repo`, `branch`
 */
export function parseTaskFile(content: string, defaultIdentifier?: string): ParsedTaskFile {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) {
    throw new Error("Task file must begin with a YAML front matter block delimited by ---");
  }
  const [, yamlBlock, body] = match;

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(yamlBlock);
    fm = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(
      `Task file front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof fm.title !== "string" || !fm.title.trim()) {
    throw new Error("Task file front matter must include a non-empty 'title' field");
  }

  const identifier =
    typeof fm.identifier === "string" && fm.identifier.trim()
      ? fm.identifier.trim()
      : (defaultIdentifier ?? `DEV-${Date.now()}`);

  const maxTurns = toPositiveInt(fm.maxTurns);
  const maxIterations = toPositiveInt(fm.maxIterations);
  const repo = typeof fm.repo === "string" && fm.repo.trim() ? fm.repo.trim() : undefined;
  const branch = typeof fm.branch === "string" && fm.branch.trim() ? fm.branch.trim() : undefined;

  return {
    identifier,
    title: fm.title.trim(),
    description: body.trim(),
    maxTurns,
    maxIterations,
    repo,
    branch,
  };
}

export function parseTaskFileFromPath(filePath: string, defaultIdentifier?: string): ParsedTaskFile {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read task file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseTaskFile(content, defaultIdentifier);
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}
