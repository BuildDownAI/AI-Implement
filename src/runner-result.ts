import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function collectRunnerComments(workspaceDir: string): Array<{ body: string }> {
  const dir = join(workspaceDir, "ai-output", "comments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => ({ body: readFileSync(join(dir, n), "utf-8") }));
}

/**
 * Pull planning context from the orchestrator's provider-agnostic endpoint using
 * the run's reusable progress token. The runner never holds a ticketing-system
 * API key. Best-effort: any failure yields "" so the implementation run proceeds.
 */
export async function fetchPlanningContextFromOrchestrator(params: {
  callbackUrl: string;
  progressToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${params.callbackUrl.replace(/\/$/, "")}/runner/planning-context`, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.progressToken}` },
    });
    if (!res.ok) {
      console.warn(`[runner] planning-context fetch failed HTTP ${res.status}; proceeding without it.`);
      return "";
    }
    const data = (await res.json()) as { planningContext?: unknown };
    return typeof data.planningContext === "string" ? data.planningContext : "";
  } catch (err) {
    console.warn("[runner] planning-context fetch failed; proceeding without it:", err);
    return "";
  }
}

export async function postRunnerResult(params: {
  phase: "planning" | "implementation" | "gap-analysis";
  workspaceDir: string;
  outcome: "success" | "failure";
  prUrl?: string;
  failureReason?: string;
  /** Machine-readable code set when a known guardrail trips (e.g. "SENSITIVE_FILES_BLOCKED"). */
  failureCode?: string;
  /**
   * Resolved callback URL, e.g. from resolveRunnerInputs()/the envelope's runnerCallbackUrl.
   * Falls back to the legacy RUNNER_CALLBACK_URL env var (never set in GHA envelope mode,
   * where the URL travels inside AI_IMPLEMENT_RUN_CONFIG instead).
   */
  callbackUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const callbackUrl = params.callbackUrl ?? process.env.RUNNER_CALLBACK_URL;
  const runToken = process.env.RUN_TOKEN;
  if (!callbackUrl || !runToken) return;
  let comments: Array<{ body: string }> = [];
  try {
    comments = collectRunnerComments(params.workspaceDir);
  } catch (err) {
    console.warn("[runner-callback] comment collection failed:", err);
  }
  const body: Record<string, unknown> = { phase: params.phase, outcome: params.outcome, comments };
  if (params.prUrl) body.prUrl = params.prUrl;
  if (params.failureReason) body.failureReason = params.failureReason;
  if (params.failureCode) body.failureCode = params.failureCode;
  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${callbackUrl.replace(/\/$/, "")}/runner/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      console.error(`[runner-callback] POST failed HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  } catch (err) {
    console.error("[runner-callback] POST failed:", err);
  }
}
