import { parse as parseYaml } from "yaml";
import type { FeatureBranchMode } from "./pipeline/branch-name.js";

/**
 * `ai-implement.yml` — per-issue configuration for the orchestrator, carried in a fenced code
 * block in the issue description and marked by a `# ai-implement.yml` first line.
 *
 * Why the description and not a file attachment: both providers already fetch the description
 * (Linear natively, Jira via adfToPlainText), so this needs no new API surface and one parser
 * serves both trackers. Linear has no first-class file attachment — an uploaded file becomes a
 * markdown link that must be parsed out of the description and fetched with auth anyway — and
 * Jira's attachment API is unrelated to Linear's.
 *
 * Why a marker rather than sniffing for a known key: the marker keeps the block findable
 * independent of its contents, so future keys need no change here; and it proves intent, which
 * is what lets the warn ladder be precise (a broken MARKED block is unambiguously ours).
 *
 * This module is location-agnostic by design — it takes text. Moving config to a comment later
 * would change only the caller, not this file.
 *
 * Fails open in every direction: any absent, unreadable, or unrecognized config resolves to
 * today's behaviour (feature-node mode). A bad config can never strand a dispatch or invent a
 * branch.
 */
export interface IssueConfig {
  featureBranch: { mode: FeatureBranchMode };
}

export interface ParsedIssueConfig {
  config: IssueConfig;
  /**
   * The description with the ai-implement.yml block removed — this becomes
   * TicketIssue.description and is therefore what the runner hands Claude as the spec.
   * Orchestrator config is metadata, not spec, and must never reach the prompt: at scale a
   * large config block risks the agent trying to CREATE the file it is reading. Unchanged
   * when no marked block was found.
   */
  description: string | null;
}

const DEFAULT_CONFIG: IssueConfig = { featureBranch: { mode: "feature" } };

/** Any fenced block. The info string is deliberately NOT part of the selector: Jira's editor does
 *  not require a language tag, and its ADF codeBlock.attrs.language comes from a closed picker
 *  list, so an info-string marker would not survive the round trip. */
const FENCED_BLOCK_RE = /```[^\n]*\n([\s\S]*?)```/g;

/** The block's first non-blank line. A YAML comment, so the parser ignores it, and plain text
 *  inside an ADF codeBlock, so it survives Jira verbatim. */
const CONFIG_MARKER_RE = /^#\s*ai-implement\.ya?ml\s*$/;

const CONFIG_KEY = "feature_branch";

const firstNonBlankLine = (body: string): string =>
  body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

/** Match adfToPlainText's own tidy-up so a strip can't leave a run of blank lines behind. */
const tidy = (text: string): string | null => text.replace(/\n{3,}/g, "\n\n").trim() || null;

/**
 * Parses the `ai-implement.yml` config out of an issue description, and returns the description
 * with that block removed.
 *
 * The first fenced block whose first non-blank line is the marker wins. A marked block is always
 * stripped, even when broken — it is ours either way, and it is not spec. An unmarked block is
 * never touched. `issueKey` is used for log context only.
 */
export function parseIssueConfig(
  description: string | null | undefined,
  issueKey = "issue",
): ParsedIssueConfig {
  if (!description) return { config: DEFAULT_CONFIG, description: description ?? null };

  for (const match of description.matchAll(FENCED_BLOCK_RE)) {
    const body = match[1];
    if (!CONFIG_MARKER_RE.test(firstNonBlankLine(body))) continue;

    const stripped = tidy(
      description.slice(0, match.index) + description.slice(match.index! + match[0].length),
    );
    const result = (config: IssueConfig): ParsedIssueConfig => ({ config, description: stripped });

    let doc: unknown;
    try {
      doc = parseYaml(body);
    } catch (err) {
      // The marker proves this block was meant to be ours, so a parse failure is a real
      // misconfiguration worth surfacing — no substring sniffing needed.
      console.warn(`[issue-config] ${issueKey}: ai-implement.yml is not valid YAML; using feature-node mode:`, err);
      return result(DEFAULT_CONFIG);
    }

    // A marked block with no feature_branch key is ordinary config once other keys exist.
    if (!doc || typeof doc !== "object" || !(CONFIG_KEY in doc)) return result(DEFAULT_CONFIG);

    const featureBranch = (doc as Record<string, unknown>)[CONFIG_KEY];
    if (!featureBranch || typeof featureBranch !== "object") {
      console.warn(`[issue-config] ${issueKey}: ${CONFIG_KEY} is not a mapping; using feature-node mode`);
      return result(DEFAULT_CONFIG);
    }

    const mode = (featureBranch as Record<string, unknown>).mode;
    if (mode === "feature" || mode === "multi-issue") return result({ featureBranch: { mode } });

    console.warn(
      `[issue-config] ${issueKey}: unknown ${CONFIG_KEY}.mode ${JSON.stringify(mode)}; using feature-node mode`,
    );
    return result(DEFAULT_CONFIG);
  }

  return { config: DEFAULT_CONFIG, description };
}
