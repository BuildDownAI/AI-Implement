import type { TicketingProvider } from "./providers/types.js";

export type StatusEvent =
  | { type: "machine_created"; machineName: string }
  | { type: "setup_complete" }
  | { type: "implementation_complete"; prNumber: number; prUrl: string }
  | { type: "verify_running" }
  | { type: "verify_passed" }
  | { type: "verify_failed"; summary: string }
  | { type: "machine_destroyed"; durationMs: number }
  | { type: "error"; reason: string }
  | { type: "timeout"; reason: string };

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatStatusComment(event: StatusEvent, machineLogsUrl?: string): string {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  let body: string;
  switch (event.type) {
    case "machine_created":
      body = `🚀 Session machine \`${event.machineName}\` created. Cloning repo and running setup...`;
      break;
    case "setup_complete":
      body = `✅ Environment ready. Claude is implementing...`;
      break;
    case "implementation_complete":
      body = `📝 Claude finished. PR #${event.prNumber} opened: ${event.prUrl}`;
      break;
    case "verify_running":
      body = `🧪 Running verification script...`;
      break;
    case "verify_passed":
      body = `✅ Verification passed`;
      break;
    case "verify_failed":
      body = `❌ Verification failed: ${event.summary}`;
      break;
    case "machine_destroyed": {
      const dur = formatDuration(event.durationMs);
      body = `🧹 Session machine cleaned up. Duration: ${dur}`;
      break;
    }
    case "error":
      body = `⚠️ Session failed: ${event.reason}. Machine will be cleaned up.`;
      break;
    case "timeout":
      body = `⚠️ Session timed out: ${event.reason}. Machine will be cleaned up.`;
      break;
  }

  let comment = `${body}\n\n_${ts}_`;
  if (machineLogsUrl) {
    comment += ` · [Machine logs](${machineLogsUrl})`;
  }
  return comment;
}

export async function postStatusComment(
  provider: TicketingProvider,
  issueId: string,
  event: StatusEvent,
  machineLogsUrl?: string,
): Promise<void> {
  const body = formatStatusComment(event, machineLogsUrl);
  await provider.postComment(issueId, body);
}
