/**
 * How a runtime failure reaches the setup checks: it names the checks that explain it, in its log line or tracker comment, and asks
 * the SetupChecks object to run them again (`recheck`, `src/restate/setup-checks.ts`), plus the hold's own bookkeeping. This module
 * imports no check and nothing that reads one, so any runtime path can import it without joining the check list's imports.
 * What reads the check list (a recheck's scope, its hold, the checks it waits on) stays in `./index.ts`.
 */
import { classifyGitHubAppError, type GitHubAppErrorCategory } from "../github-errors.js";
import type { ReferenceRepoResultCause } from "../reference-repos.js";
import { NEEDS_ATTENTION, type SetupCheckId, type SetupCheckResult, type SetupRecheckCause } from "./contract.js";
import type { SetupCheckRun, SetupCheckScope } from "./index.js";

// The setup checks' time in this module. The change detector's interval is in change-detector.ts, the ingress bounds in src/restate/setup-checks.ts, the Setup page's polls in its own module.
/** How long a recheck answers for its rows: within it, another recheck of them does nothing. */
export const RECHECK_HOLD_MS = 60 * 60_000;

/** A runtime failure's request to run a check again: the check, the project it failed for, and what kind of failure named it. */
export interface SetupCheckRecheck {
  id: SetupCheckId;
  project?: string;
  cause?: SetupRecheckCause;
}

// The one way code outside src/restate/ reaches the SetupChecks object's recheck: startServer sets the sender, and until then a request does nothing.
let recheckSender: ((request: SetupCheckRecheck) => Promise<unknown>) | null = null;
export function setSetupCheckRecheckSender(send: ((request: SetupCheckRecheck) => Promise<unknown>) | null): void {
  recheckSender = send;
}

/** Asks for a check to run again for the runtime failure that names it, without waiting on the run and without throwing. */
export function recheckSetupCheck(request: SetupCheckRecheck): void {
  recheckSender?.(request).catch((err) => console.warn(`[setup-checks] recheck of ${request.id} could not be sent:`, err));
}

/** The checks behind a runtime failure, the project it failed for when it has one, and what kind of failure it was. */
export interface SetupCheckRechecks {
  ids: readonly SetupCheckId[];
  project?: string | null;
  cause: SetupRecheckCause;
}

/** Asks for each check behind a runtime failure to run again for its project. */
export function recheckSetupChecks({ ids, project, cause }: SetupCheckRechecks): void {
  for (const id of ids) recheckSetupCheck({ id, project: project ?? undefined, cause });
}

/** Where a reader finds the checks a line names. */
export function readOnSetupPage(count: number): string {
  return `Read ${count === 1 ? "it" : "them"} on the Setup page at /admin#setup`;
}

function setupChecksSentence(ids: readonly SetupCheckId[], name: (id: SetupCheckId) => string): string {
  return `${ids.length === 1 ? "Setup check" : "Setup checks"}: ${ids.map(name).join(", ")}. ${readOnSetupPage(ids.length)}`;
}

/**
 * Asks for each check behind a runtime failure to run again for its project, and answers the sentence its log line ends with, empty for none.
 * The sentence never says the checks ran: Restate may be unable to take the request, and a recheck within the hour is held.
 */
export function pointAtSetupChecks(rechecks: SetupCheckRechecks): string {
  recheckSetupChecks(rechecks);
  return rechecks.ids.length === 0 ? "" : `. ${setupChecksSentence(rechecks.ids, (id) => id)}`;
}

/** The sentence a tracker comment names setup checks with: their ids only, since a check's detail and fix stay on the Setup page. */
export function trackerSetupChecksSentence(ids: readonly SetupCheckId[]): string {
  return ids.length === 0 ? "" : `${setupChecksSentence(ids, (id) => `\`${id}\``)}.`;
}

/** The setup checks behind each category of GitHub App error, for every runtime read that meets one. */
const GITHUB_APP_ERROR_CHECKS: Readonly<Record<GitHubAppErrorCategory, readonly SetupCheckId[]>> = {
  "clock-skew-suspected": ["github.app-identity", "github.clock"],
  "app-not-installed": ["github.installation"],
  "repo-not-found": ["github.installation"],
  "permission-denied": ["github.permissions"],
  unknown: [],
};

/** The setup checks that explain a GitHub App error, none for one no setup fault explains. */
export function gitHubAppErrorChecks(err: unknown): readonly SetupCheckId[] {
  return GITHUB_APP_ERROR_CHECKS[classifyGitHubAppError(err)];
}

/** The setup checks behind each failure code a runner reports that a setup fault explains. */
const RUNNER_FAILURE_CHECKS: Readonly<Partial<Record<string, readonly SetupCheckId[]>>> = {
  GIT_AUTH: ["github.permissions"],
  CHECKS_PERMISSION_DENIED: ["github.permissions"],
  PROVIDER_AUTH: ["model.credentials-adopted"],
};

/**
 * The setup checks that explain a failure a runner reported, none for one no setup fault explains.
 * A refused model credential names the adoption check only for a run without a managed credential, the one case that check reports.
 */
export function runnerFailureChecks(code: string | undefined, { managedCredential }: { managedCredential: boolean }): readonly SetupCheckId[] {
  if (code === undefined || (code === "PROVIDER_AUTH" && managedCredential)) return [];
  return RUNNER_FAILURE_CHECKS[code] ?? [];
}

/** The reasons a reference repository misses a run that `github.reference-repos` reads: the App's reach on its owner, and its declared ref. */
const REFERENCE_REPO_CHECKED_CAUSES: ReadonlySet<ReferenceRepoResultCause> = new Set(["no-auth", "ref-not-found", "token-error"]);

/** The setup checks that explain reference repositories missing from a run, none when no setup fault explains any of them. */
export function referenceRepoChecks(missed: readonly { cause?: ReferenceRepoResultCause }[]): readonly SetupCheckId[] {
  return missed.some((r) => r.cause !== undefined && REFERENCE_REPO_CHECKED_CAUSES.has(r.cause)) ? ["github.reference-repos"] : [];
}

/** Whether a row needs attention for `project`: its own row of a per-project check, any row of an orchestrator-wide one. */
export function rowNeedsAttention(row: SetupCheckResult, project: string | null): boolean {
  return NEEDS_ATTENTION.includes(row.state) && (row.project === undefined || row.project === project);
}

/** Which of `ids` the run shows needing attention for `project`. */
export function checksNeedingAttention(run: SetupCheckRun | null, ids: readonly SetupCheckId[], project: string | null): SetupCheckId[] {
  if (run === null) return [];
  return ids.filter((id) => run.results.some((row) => row.id === id && rowNeedsAttention(row, project)));
}

/** The key a recheck's time is kept under: its scope's checks, and its projects when it names some. */
export function recheckKey(scope: SetupCheckScope): string {
  return scope.projects === undefined ? scope.checks.join(",") : `${scope.checks.join(",")} ${scope.projects.join(",")}`;
}

/** The recheck times still within the hold, with this one added, so the kept times never outgrow the hour. */
export function rememberRecheck(times: Readonly<Record<string, number>>, key: string, now: number): Record<string, number> {
  return { ...Object.fromEntries(Object.entries(times).filter(([, at]) => now - at < RECHECK_HOLD_MS)), [key]: now };
}
