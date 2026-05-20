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
