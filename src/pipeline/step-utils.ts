import type { LLMResult } from "./types.js";

export function formatLlmResultDetail(result: { stdout?: string; stderr?: string }): string {
  const detail = (result.stderr || result.stdout || "").trim();
  return detail ? `: ${detail}` : "";
}

export function formatGitNameStatusSummary(stdout: string): string {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  return lines.map((line) => {
    const [status, file] = line.split(/\s+/, 2);
    const label = status === "A" ? "Added" : status === "M" ? "Modified" : status === "D" ? "Deleted" : "Changed";
    return `- ${label}: \`${file ?? line}\``;
  }).join("\n");
}

/** Both review stages require a successful terminal event before using a verdict. */
export function terminalResultFailureMessage(
  result: Pick<LLMResult, "terminalStatus" | "telemetry" | "stdout" | "stderr">,
  label: string,
): string | null {
  const detail = formatLlmResultDetail(result);
  if (!result.terminalStatus) return `${label} did not return a terminal result event${detail}`;
  const { subtype, isError } = result.terminalStatus;
  if (isError === true) return `${label} returned an error terminal result (subtype=${subtype ?? "unknown"})${detail}`;
  if (subtype !== "success") return `${label} finished without a successful terminal result (subtype=${subtype ?? "unknown"})${detail}`;
  if (result.telemetry?.outcome && result.telemetry.outcome !== "success") {
    return `${label} finished without a successful terminal result (${result.telemetry.outcome})${detail}`;
  }
  return null;
}
