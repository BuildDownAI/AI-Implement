import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SessionApiModule from "../session-api.js";
import type * as LogModule from "../log.js";
import type * as DedupModule from "../dedup.js";

vi.mock("../status-events.js", () => ({
  postStatusComment: vi.fn(),
}));

class MockRequest extends EventEmitter {
  url?: string;
  method?: string;
  headers: Record<string, string>;

  constructor(url: string, method: string, headers: Record<string, string> = {}, body?: string) {
    super();
    this.url = url;
    this.method = method;
    this.headers = headers;
    process.nextTick(() => {
      if (body) this.emit("data", Buffer.from(body));
      this.emit("end");
    });
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => { this.resolver = resolve; });

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

let dbPath: string;
let sessionApi: typeof SessionApiModule;
let log: typeof LogModule;
let dedup: typeof DedupModule;
let mockPostStatusComment: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `session-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  sessionApi = await import("../session-api.js");
  const statusEvents = await import("../status-events.js");
  mockPostStatusComment = vi.mocked(statusEvents.postStatusComment);
  log.initLogTable();
});

afterEach(() => {
  vi.restoreAllMocks();
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

async function callStatusEndpoint(
  body: unknown,
  flyAppName?: string,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest("/api/status", "POST", {}, JSON.stringify(body));
  const res = new MockResponse();
  sessionApi.handleStatusUpdate(req as never, res as never, "test-linear-key", flyAppName);
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

describe("handleStatusUpdate", () => {
  describe("validation", () => {
    it("returns 400 for invalid JSON", async () => {
      const req = new MockRequest("/api/status", "POST", {}, "not-json");
      const res = new MockResponse();
      sessionApi.handleStatusUpdate(req as never, res as never, "key");
      await res.done;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Invalid JSON");
    });

    it("returns 400 when nonce is missing", async () => {
      const res = await callStatusEndpoint({ event: "setup_complete" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("nonce");
    });

    it("returns 400 when event is missing", async () => {
      const res = await callStatusEndpoint({ nonce: "abc" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("event");
    });

    it("returns 400 for unknown event type", async () => {
      const res = await callStatusEndpoint({ nonce: "abc", event: "unknown_event" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Unknown event type");
    });

    it("returns 403 for unknown or expired nonce", async () => {
      const res = await callStatusEndpoint({ nonce: "not-in-db", event: "setup_complete" });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Invalid or expired nonce");
    });
  });

  describe("successful events", () => {
    let jobNonce: string;

    beforeEach(() => {
      mockPostStatusComment.mockClear();
      jobNonce = `test-nonce-${Math.random().toString(36).slice(2)}`;
      log.appendLog({
        issueId: "issue-99",
        issueIdentifier: "ENG-99",
        repo: "acme/repo",
        machineNonce: jobNonce,
        machineId: "machine-abc",
        executionMode: "fly-machines",
      });
    });

    it("posts setup_complete and returns 200", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);

      const res = await callStatusEndpoint({ nonce: jobNonce, event: "setup_complete" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);

      expect(mockPostStatusComment).toHaveBeenCalledOnce();
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "setup_complete" });
    });

    it("posts implementation_complete with PR details", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);

      const res = await callStatusEndpoint({
        nonce: jobNonce,
        event: "implementation_complete",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
      });
      expect(res.statusCode).toBe(200);

      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({
        type: "implementation_complete",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
      });
    });

    it("posts verify_running", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "verify_running" });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "verify_running" });
    });

    it("posts verify_passed", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "verify_passed" });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "verify_passed" });
    });

    it("posts verify_failed with summary", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({
        nonce: jobNonce,
        event: "verify_failed",
        summary: "npm test failed: 3 suites failed",
      });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({
        type: "verify_failed",
        summary: "npm test failed: 3 suites failed",
      });
    });

    it("uses default summary when summary is missing from verify_failed", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "verify_failed" });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "verify_failed", summary: "Verify script failed" });
    });

    it("posts error event with reason", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "error", reason: "setup script failed" });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "error", reason: "setup script failed" });
    });

    it("uses default reason when reason is missing from error", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "error" });
      const [, , event] = mockPostStatusComment.mock.calls[0];
      expect(event).toEqual({ type: "error", reason: "unknown error" });
    });

    it("includes machine logs URL when flyAppName and machineId are available", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "setup_complete" }, "my-fly-app");
      const [, , , machineLogsUrl] = mockPostStatusComment.mock.calls[0];
      expect(machineLogsUrl).toBe("https://fly.io/apps/my-fly-app/machines/machine-abc");
    });

    it("passes undefined machineLogsUrl when flyAppName is not set", async () => {
      mockPostStatusComment.mockResolvedValueOnce(undefined);
      await callStatusEndpoint({ nonce: jobNonce, event: "setup_complete" });
      const [, , , machineLogsUrl] = mockPostStatusComment.mock.calls[0];
      expect(machineLogsUrl).toBeUndefined();
    });

    it("returns 403 for a terminal job's nonce", async () => {
      const jobId = log.appendLog({
        issueId: "issue-100",
        repo: "acme/repo",
        machineNonce: "terminal-nonce",
      });
      log.updateJobStatus(jobId, "completed", "success");

      const res = await callStatusEndpoint({ nonce: "terminal-nonce", event: "setup_complete" });
      expect(res.statusCode).toBe(403);
    });

    it("returns 500 when postStatusComment throws", async () => {
      mockPostStatusComment.mockRejectedValueOnce(new Error("Linear API error"));
      const res = await callStatusEndpoint({ nonce: jobNonce, event: "setup_complete" });
      expect(res.statusCode).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// handleStepReport
// ---------------------------------------------------------------------------

async function callStepReportEndpoint(
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = new MockRequest("/api/step-report", "POST", {}, JSON.stringify(body));
  const res = new MockResponse();
  sessionApi.handleStepReport(req as never, res as never);
  await res.done;
  return { statusCode: res.statusCode, body: res.body };
}

function validStep() {
  return {
    id: "clone",
    type: "clone",
    status: "passed",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:05.000Z",
    parent_step_id: null,
    inputs: {},
    outputs: { workspaceDir: "/tmp/work" },
    logs_url: null,
  };
}

describe("handleStepReport", () => {
  let reportJobNonce: string;

  beforeEach(async () => {
    const stepLog = await import("../step-log.js");
    stepLog.initStepLogTable();

    reportJobNonce = `report-nonce-${Math.random().toString(36).slice(2)}`;
    log.appendLog({
      issueId: "issue-300",
      issueIdentifier: "ENG-300",
      repo: "acme/repo",
      machineNonce: reportJobNonce,
      machineId: "machine-report",
      executionMode: "fly-machines",
    });
  });

  describe("validation", () => {
    it("returns 400 for invalid JSON", async () => {
      const req = new MockRequest("/api/step-report", "POST", {}, "not-json");
      const res = new MockResponse();
      sessionApi.handleStepReport(req as never, res as never);
      await res.done;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Invalid JSON");
    });

    it("returns 400 when nonce is missing", async () => {
      const res = await callStepReportEndpoint({ step: validStep() });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("nonce");
    });

    it("returns 400 when step is missing", async () => {
      const res = await callStepReportEndpoint({ nonce: reportJobNonce });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("step");
    });

    it("returns 400 when step.id is missing", async () => {
      const { id: _id, ...stepWithoutId } = validStep();
      const res = await callStepReportEndpoint({ nonce: reportJobNonce, step: stepWithoutId });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("step.id");
    });

    it("returns 400 when step.type is missing", async () => {
      const { type: _type, ...stepWithoutType } = validStep();
      const res = await callStepReportEndpoint({ nonce: reportJobNonce, step: stepWithoutType });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("step.type");
    });

    it("returns 400 when step.status is missing", async () => {
      const { status: _status, ...stepWithoutStatus } = validStep();
      const res = await callStepReportEndpoint({ nonce: reportJobNonce, step: stepWithoutStatus });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("step.status");
    });

    it("returns 400 when step.started_at is missing", async () => {
      const { started_at: _sa, ...stepWithoutStartedAt } = validStep();
      const res = await callStepReportEndpoint({ nonce: reportJobNonce, step: stepWithoutStartedAt });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("step.started_at");
    });

    it("returns 403 for unknown or expired nonce", async () => {
      const res = await callStepReportEndpoint({ nonce: "not-in-db", step: validStep() });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("Invalid or expired nonce");
    });
  });

  describe("successful step report", () => {
    it("returns 200 and persists the step record", async () => {
      const res = await callStepReportEndpoint({ nonce: reportJobNonce, step: validStep() });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);

      const stepLog = await import("../step-log.js");
      const job = log.getJobByNonce(reportJobNonce)!;
      const records = stepLog.getStepsByJobId(job.id);
      expect(records).toHaveLength(1);
      expect(records[0].stepId).toBe("clone");
      expect(records[0].status).toBe("passed");
    });

    it("updates an existing step record on conflict (running → passed)", async () => {
      const stepLog = await import("../step-log.js");
      const job = log.getJobByNonce(reportJobNonce)!;

      // First report: running
      const runningStep = { ...validStep(), status: "running", ended_at: null, outputs: {} };
      await callStepReportEndpoint({ nonce: reportJobNonce, step: runningStep });
      const before = stepLog.getStepRecord(job.id, "clone")!;
      expect(before.status).toBe("running");

      // Second report: passed
      await callStepReportEndpoint({ nonce: reportJobNonce, step: validStep() });
      const after = stepLog.getStepRecord(job.id, "clone")!;
      expect(after.status).toBe("passed");
      expect(after.outputsJson).toContain("workspaceDir");
    });
  });
});
