import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import { FakeProvider } from "./providers/fake.js";

const SECRET = "integration-test-secret";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `integration-callback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerTokens = await import("../runner-tokens.js");
  runnerCallback = await import("../runner-callback.js");
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe("dispatch → callback round-trip", () => {
  it("planning happy path: mint, simulated dispatch, runner POSTs back, status transitions", async () => {
    // 1. Set up a fake provider pre-populated with the issue so commentsFor() survives transition.
    const fake = new FakeProvider({
      initialIssues: [{
        id: "uuid-1", identifier: "ENG-1", title: "t", description: null,
        scopeKey: "ENG", nativeStatus: "Todo (unstarted)",
      }],
      recordCalls: true,
    });

    // 2. Simulate orchestrator-side mint at dispatch time.
    const { token } = runnerTokens.mintRunToken({
      issueId: "uuid-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });

    // 3. Simulate runner-side POST back after planning succeeds.
    const result = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "planning",
        outcome: "success",
        comments: [
          { body: "## Analysis\n\nRoot cause is X" },
          { body: "## Test plan\n\n- assert Y" },
        ],
      },
      secret: SECRET,
      resolveProvider: async (mappingTeamKey) => {
        expect(mappingTeamKey).toBe("ENG");
        return fake;
      },
    });

    // 4. Verify the orchestrator-side effects.
    expect(result.status).toBe(200);
    expect(fake.commentsFor("uuid-1")).toEqual([
      "## Analysis\n\nRoot cause is X",
      "## Test plan\n\n- assert Y",
    ]);
    expect(fake.getPhase("uuid-1")).toBe("plan_complete");

    // 5. Token is one-time-use.
    const replay = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: async () => fake,
    });
    expect(replay.status).toBe(409);
  });

  it("implementation failure path: status transitions to Implementation Failed; no PR required", async () => {
    const fake = new FakeProvider({
      initialIssues: [{
        id: "uuid-2", identifier: "ENG-2", title: "t", description: null,
        scopeKey: "ENG", nativeStatus: "In Progress (started)",
      }],
      recordCalls: true,
    });
    const { token } = runnerTokens.mintRunToken({
      issueId: "uuid-2",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: {
        phase: "implementation",
        outcome: "failure",
        failureReason: "tests timed out",
        comments: [{ body: "Logs..." }],
      },
      secret: SECRET,
      resolveProvider: async () => fake,
    });

    expect(result.status).toBe(200);
    const calls = fake.recordedCalls();
    expect(calls.find((c) => c.method === "markImplementationFailed")?.args).toEqual([
      "uuid-2",
      "tests timed out",
    ]);
  });
});
