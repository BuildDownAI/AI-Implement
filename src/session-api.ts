import http from "node:http";
import { getJobByNonce } from "./log.js";
import { postStatusComment } from "./status-events.js";
import type { StatusEvent } from "./status-events.js";
import type { TicketingProvider } from "./providers/types.js";
import { upsertStepRecord } from "./step-log.js";
import type { Step } from "./pipeline/types.js";

const ALLOWED_REMOTE_EVENTS = new Set([
  "setup_complete",
  "implementation_complete",
  "verify_running",
  "verify_passed",
  "verify_failed",
  "error",
]);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function handleStepReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { nonce, step } = raw;

    if (!nonce || typeof nonce !== "string") {
      json(res, 400, { error: "nonce is required" });
      return;
    }
    if (!step || typeof step !== "object") {
      json(res, 400, { error: "step is required" });
      return;
    }

    const job = getJobByNonce(nonce);
    if (!job) {
      json(res, 403, { error: "Invalid or expired nonce" });
      return;
    }

    // Validate required Step fields before persisting
    const s = step as Record<string, unknown>;
    if (!s.id || typeof s.id !== "string") {
      json(res, 400, { error: "step.id is required and must be a string" });
      return;
    }
    if (!s.type || typeof s.type !== "string") {
      json(res, 400, { error: "step.type is required and must be a string" });
      return;
    }
    if (!s.status || typeof s.status !== "string") {
      json(res, 400, { error: "step.status is required and must be a string" });
      return;
    }
    if (!s.started_at || typeof s.started_at !== "string") {
      json(res, 400, { error: "step.started_at is required and must be a string" });
      return;
    }

    upsertStepRecord(job.id, step as Step);
    json(res, 200, { ok: true });
  } catch (err) {
    console.error("[session-api] Error handling step report:", err);
    json(res, 500, { error: "Internal server error" });
  }
}

export async function handleStatusUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: TicketingProvider,
  flyAppName?: string,
): Promise<void> {
  try {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { nonce, event: eventType } = raw;

    if (!nonce || typeof nonce !== "string") {
      json(res, 400, { error: "nonce is required" });
      return;
    }
    if (!eventType || typeof eventType !== "string") {
      json(res, 400, { error: "event is required" });
      return;
    }
    if (!ALLOWED_REMOTE_EVENTS.has(eventType)) {
      json(res, 400, { error: `Unknown event type: ${eventType}` });
      return;
    }

    const job = getJobByNonce(nonce);
    if (!job) {
      json(res, 403, { error: "Invalid or expired nonce" });
      return;
    }

    let machineLogsUrl: string | undefined;
    if (flyAppName && job.machineId) {
      machineLogsUrl = `https://fly.io/apps/${flyAppName}/machines/${job.machineId}`;
    }

    let statusEvent: StatusEvent;
    if (eventType === "setup_complete") {
      statusEvent = { type: "setup_complete" };
    } else if (eventType === "implementation_complete") {
      const prNumber = typeof raw.prNumber === "number" ? raw.prNumber : 0;
      const prUrl = typeof raw.prUrl === "string" ? raw.prUrl : "";
      statusEvent = { type: "implementation_complete", prNumber, prUrl };
    } else if (eventType === "verify_running") {
      statusEvent = { type: "verify_running" };
    } else if (eventType === "verify_passed") {
      statusEvent = { type: "verify_passed" };
    } else if (eventType === "verify_failed") {
      const summary = typeof raw.summary === "string" ? raw.summary : "Verify script failed";
      statusEvent = { type: "verify_failed", summary };
    } else {
      // eventType === "error"
      const reason = typeof raw.reason === "string" ? raw.reason : "unknown error";
      statusEvent = { type: "error", reason };
    }

    await postStatusComment(provider, job.issueId, statusEvent, machineLogsUrl);
    json(res, 200, { ok: true });
  } catch (err) {
    console.error("[session-api] Error handling status update:", err);
    json(res, 500, { error: "Internal server error" });
  }
}
