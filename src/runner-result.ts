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

export async function postRunnerResult(params: {
  phase: "planning" | "implementation";
  workspaceDir: string;
  outcome: "success" | "failure";
  prUrl?: string;
  failureReason?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const callbackUrl = process.env.RUNNER_CALLBACK_URL;
  const runToken = process.env.RUN_TOKEN;
  if (!callbackUrl || !runToken) return;
  if (params.phase === "implementation" && params.outcome === "success" && !params.prUrl) {
    console.warn("RUNNER_CALLBACK_URL set but no PR URL; skipping callback.");
    return;
  }
  let comments: Array<{ body: string }> = [];
  try {
    comments = collectRunnerComments(params.workspaceDir);
  } catch (err) {
    console.warn("[runner-callback] comment collection failed:", err);
  }
  const body: Record<string, unknown> = { phase: params.phase, outcome: params.outcome, comments };
  if (params.prUrl) body.prUrl = params.prUrl;
  if (params.failureReason) body.failureReason = params.failureReason;
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
