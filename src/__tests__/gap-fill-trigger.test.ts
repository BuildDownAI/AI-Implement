import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as GapFillModule from "../gap-fill-trigger.js";
import type { RepoMapping } from "../config.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";

let dbPath: string;
let dedup: typeof DedupModule;
let gapFill: typeof GapFillModule;
let handleGapFillTrigger: typeof GapFillModule.handleGapFillTrigger;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `gap-fill-trigger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  gapFill = await import("../gap-fill-trigger.js");
  handleGapFillTrigger = gapFill.handleGapFillTrigger;
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

const SECRET = "gap-fill-trigger-secret";
const RUNNER_SECRET = "runner-token-secret-with-enough-entropy";
const CALLBACK_URL = "https://orch.example.com";

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "test",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    awsRegion: null,
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<TicketIssue> = {}): TicketIssue {
  return {
    id: "issue-uuid-1",
    identifier: "ACME-123",
    title: "Test issue",
    description: null,
    scopeKey: "ACME",
    nativeStatus: "Ready",
    ...overrides,
  };
}

function makeInput(overrides: Partial<Parameters<typeof handleGapFillTrigger>[0]> = {}) {
  return {
    authorization: `Bearer ${SECRET}`,
    body: { issueKey: "ACME-123", prNumber: 42 },
    triggerSecret: SECRET,
    runnerCallbackBaseUrl: null as string | null,
    runnerTokenSecret: null as string | null,
    getMappings: () => ({}) as Record<string, RepoMapping>,
    resolveProvider: async (_m: RepoMapping): Promise<TicketingProvider> => new FakeProvider(),
    getInstallationToken: async (_owner: string) => "gh-token",
    dispatchWorkflow: vi.fn(async () => ({ success: true, status: 204 })),
    ...overrides,
  };
}

describe("handleGapFillTrigger", () => {
  it("returns 501 when trigger secret is not configured", async () => {
    const res = await handleGapFillTrigger(makeInput({ triggerSecret: null }));
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Gap fill trigger not configured");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await handleGapFillTrigger(makeInput({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 401 when bearer token doesn't match the configured secret", async () => {
    const res = await handleGapFillTrigger(makeInput({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when issueKey is missing", async () => {
    const res = await handleGapFillTrigger(makeInput({ body: { prNumber: 1 } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("issueKey and positive integer prNumber required");
  });

  it("returns 400 when prNumber is missing", async () => {
    const res = await handleGapFillTrigger(makeInput({ body: { issueKey: "ACME-1" } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when prNumber is wrong type", async () => {
    const res = await handleGapFillTrigger(
      makeInput({ body: { issueKey: "ACME-1", prNumber: "42" } as never }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when prNumber is a float", async () => {
    const res = await handleGapFillTrigger(
      makeInput({ body: { issueKey: "ACME-1", prNumber: 3.14 } }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when prNumber is negative", async () => {
    const res = await handleGapFillTrigger(
      makeInput({ body: { issueKey: "ACME-1", prNumber: -1 } }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when no mapping's findByKey matches", async () => {
    const mapping = makeMapping();
    const provider = new FakeProvider(); // empty, findByKey returns null
    const res = await handleGapFillTrigger(
      makeInput({
        getMappings: () => ({ ACME: mapping }),
        resolveProvider: async () => provider,
      }),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("mapping_not_found");
  });

  it("dispatches comment-trigger.yml and returns 200 on success", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing" });
    const issue = makeIssue({ id: "issue-uuid-1", identifier: "ACME-123", scopeKey: "ACME" });
    const provider = new FakeProvider({ initialIssues: [issue] });
    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    const res = await handleGapFillTrigger(
      makeInput({
        body: { issueKey: "ACME-123", prNumber: 42 },
        getMappings: () => ({ ACME: mapping }),
        resolveProvider: async () => provider,
        runnerCallbackBaseUrl: CALLBACK_URL,
        runnerTokenSecret: RUNNER_SECRET,
        dispatchWorkflow: dispatchSpy,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dispatched: true });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const [token, dispatchedMapping, inputs] = dispatchSpy.mock.calls[0];
    expect(token).toBe("gh-token");
    expect(dispatchedMapping.workflowFile).toBe("claude-implement.yml");
    expect(dispatchedMapping.owner).toBe("acme");
    expect(dispatchedMapping.repo).toBe("billing");
    expect(inputs.issue_id).toBe("issue-uuid-1");
    expect(inputs.issue_identifier).toBe("ACME-123");
    expect(inputs.pr_number).toBe("42");
    expect(inputs.runner_callback_url).toBe(CALLBACK_URL);
    expect(inputs.run_token).toBeTruthy();
    expect(typeof inputs.run_token).toBe("string");
  });

  it("dispatches with empty token/url when runner callback env not configured", async () => {
    const mapping = makeMapping();
    const issue = makeIssue();
    const provider = new FakeProvider({ initialIssues: [issue] });
    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    const res = await handleGapFillTrigger(
      makeInput({
        getMappings: () => ({ ACME: mapping }),
        resolveProvider: async () => provider,
        runnerCallbackBaseUrl: null,
        runnerTokenSecret: null,
        dispatchWorkflow: dispatchSpy,
      }),
    );

    expect(res.status).toBe(200);
    const [, , inputs] = dispatchSpy.mock.calls[0];
    expect(inputs.runner_callback_url).toBe("");
    expect(inputs.run_token).toBe("");
  });

  it("returns 502 when workflow_dispatch fails", async () => {
    const mapping = makeMapping();
    const issue = makeIssue();
    const provider = new FakeProvider({ initialIssues: [issue] });
    const dispatchSpy = vi.fn(async () => ({
      success: false,
      status: 422,
      error: "Workflow not found",
    }));

    const res = await handleGapFillTrigger(
      makeInput({
        getMappings: () => ({ ACME: mapping }),
        resolveProvider: async () => provider,
        dispatchWorkflow: dispatchSpy,
      }),
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("dispatch_failed");
    expect(res.body.dispatchStatus).toBe(422);
    expect(res.body.detail).toBe("Workflow not found");
  });

  it("tries multiple mappings and stops at the first match", async () => {
    const mappingA = makeMapping({ owner: "acme", repo: "a" });
    const mappingB = makeMapping({ owner: "acme", repo: "b" });
    const mappingC = makeMapping({ owner: "acme", repo: "c" });

    const providerA = new FakeProvider(); // no match
    const issue = makeIssue();
    const providerB = new FakeProvider({ initialIssues: [issue] }); // match
    const providerC = new FakeProvider(); // would not match — should not be called

    const providerCFindByKey = vi.spyOn(providerC, "findByKey");
    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));

    const res = await handleGapFillTrigger(
      makeInput({
        getMappings: () => ({ A: mappingA, B: mappingB, C: mappingC }),
        resolveProvider: async (m) => {
          if (m === mappingA) return providerA;
          if (m === mappingB) return providerB;
          return providerC;
        },
        dispatchWorkflow: dispatchSpy,
      }),
    );

    expect(res.status).toBe(200);
    expect(providerCFindByKey).not.toHaveBeenCalled();
    const [, dispatchedMapping] = dispatchSpy.mock.calls[0];
    expect(dispatchedMapping.repo).toBe("b");
  });

  it("continues to next mapping when a provider's findByKey throws", async () => {
    const mappingA = makeMapping({ owner: "acme", repo: "a" });
    const mappingB = makeMapping({ owner: "acme", repo: "b" });

    const providerA: TicketingProvider = {
      ...new FakeProvider(),
      id: "fake",
      findByKey: async () => {
        throw new Error("network blew up");
      },
    } as unknown as TicketingProvider;
    const issue = makeIssue();
    const providerB = new FakeProvider({ initialIssues: [issue] });
    const dispatchSpy = vi.fn(async () => ({ success: true, status: 204 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await handleGapFillTrigger(
      makeInput({
        getMappings: () => ({ A: mappingA, B: mappingB }),
        resolveProvider: async (m) => (m === mappingA ? providerA : providerB),
        dispatchWorkflow: dispatchSpy,
      }),
    );

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
