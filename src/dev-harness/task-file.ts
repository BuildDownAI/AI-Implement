import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseTaskDocument } from "../task-document.js";

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
 * Maps legacy developer-harness front matter fields to the current task
 * document schema so that old task files remain valid without modification.
 *
 * Mappings applied:
 *   identifier    → id         (new name wins when both are present)
 *   branch        → base       (new name wins when both are present)
 *   maxTurns      → limits.maxTurns    (new limits block wins when present)
 *   maxIterations → limits.maxIterations
 *   repo          is extracted and returned separately (not part of the schema)
 *
 * Invalid legacy limit values (zero, negative, non-integer) are silently
 * dropped to preserve backward compatibility with files that used them as
 * "unlimited" placeholders.
 */
function applyCompatibilityAdapter(
  fm: Record<string, unknown>,
  defaultIdentifier?: string,
): { adapted: Record<string, unknown>; repo: string | undefined } {
  const { repo, identifier, branch, maxTurns, maxIterations, ...rest } = fm;
  const adapted: Record<string, unknown> = { ...rest };

  // identifier → id (only when no 'id' already present and value is non-empty)
  if (typeof identifier === "string" && identifier.trim() && !("id" in rest)) {
    adapted.id = identifier.trim();
  }
  // Fall back to defaultIdentifier when neither identifier nor id was given
  if (!("id" in adapted) && defaultIdentifier !== undefined) {
    adapted.id = defaultIdentifier;
  }

  // branch → base (only when no 'base' already present and value is non-empty)
  if (typeof branch === "string" && branch.trim() && !("base" in rest)) {
    adapted.base = branch.trim();
  }

  // maxTurns / maxIterations → limits.* (only when no 'limits' block already present)
  const legacyMaxTurns = toPositiveInt(maxTurns);
  const legacyMaxIterations = toPositiveInt(maxIterations);
  if (
    (legacyMaxTurns !== undefined || legacyMaxIterations !== undefined) &&
    !("limits" in rest)
  ) {
    const limits: Record<string, number> = {};
    if (legacyMaxTurns !== undefined) limits.maxTurns = legacyMaxTurns;
    if (legacyMaxIterations !== undefined) limits.maxIterations = legacyMaxIterations;
    adapted.limits = limits;
  }

  const extractedRepo = typeof repo === "string" && repo.trim() ? repo.trim() : undefined;
  return { adapted, repo: extractedRepo };
}

/**
 * Parse a task file (YAML front matter + markdown body) used as a tracker-free
 * ticket for the local dev harness.
 *
 * Required front matter: `title`
 * Legacy front matter (mapped via compatibility adapter): `identifier`, `maxTurns`,
 *   `maxIterations`, `repo`, `branch`
 * Current front matter: `id`, `base`, `profiles`, `limits`
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
    fm =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch (err) {
    throw new Error(
      `Task file front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { adapted, repo } = applyCompatibilityAdapter(fm, defaultIdentifier);

  // yaml.stringify always appends a trailing newline; the safety check here
  // guards against a hypothetical change in that behaviour.
  const adaptedYaml = stringifyYaml(adapted);
  const sep = adaptedYaml.endsWith("\n") ? "" : "\n";
  const adaptedContent = `---\n${adaptedYaml}${sep}---\n${body}`;

  const runConfig = parseTaskDocument(adaptedContent);

  return {
    identifier: runConfig.issue.identifier,
    title: runConfig.issue.title,
    description: runConfig.issue.description,
    maxTurns: runConfig.maxTurns,
    maxIterations: runConfig.maxIterations,
    repo,
    branch: runConfig.baseBranch,
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
