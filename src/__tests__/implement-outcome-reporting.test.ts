import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { parseCodexStream } from "../pipeline/codex-stream.js";
import type { LLMExecutor, LLMResult, Step, StepReporter } from "../pipeline/types.js";
import { makeContext } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

// Unmocked implement/review steps: parseCodexStream -> executor result -> implementStep ->
// feedback loop (PassStat, sub-step outputs, cycle summary). Synthetic stream, no model call.
const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const msg = (text: string) => ({ type: "item.completed", item: { id: "m1", type: "agent_message", text } });
const CLEAN = () => parseCodexStream(stream({ type: "turn.started" }, msg("ok"), { type: "turn.completed" })).toResult({ exitCode: 0 });
const ERRORED = () =>
  parseCodexStream(
    stream({ type: "turn.started" }, { type: "error", message: "stream disconnected before completion" }, msg("ok"), { type: "turn.completed" }),
  ).toResult({ exitCode: 0 });
const VERDICT = (approved: boolean) => ({
  approved,
  blocking_issues: approved ? [] : [{ title: "Gap", problem: "Missing test", required_fix: "Add it" }],
  score: approved ? 95 : 40,
  progress_delta: 50,
  feedback: approved ? "Looks good" : "Needs work",
});
const reviewResult = (approved: boolean): LLMResult => ({
  stdout: "",
  exitCode: 0,
  tokensUsed: 0,
  terminalStatus: { subtype: "success", isError: false },
  telemetry: { outcome: "success", numTurns: 1, durationMs: 1, costUsd: null, tokensIn: null, tokensOut: null },
  structuredOutput: VERDICT(approved),
});

describe("TEST-2 shape: pass 1 success/rejected, pass 2 error/approved", () => {
  let dir: string;
  beforeEach(() => {
    dir = testDir("outcome-report");
    vi.mocked(spawnSync).mockImplementation(((_c: unknown, args?: readonly string[]) => ({
      status: 0,
      stdout: Buffer.from((args ?? [])[0] === "status" ? "" : "diff --git a/f.ts\n+x"),
      stderr: Buffer.from(""),
      pid: 0, output: [], signal: null, error: undefined,
    })) as never);
  });

  it("keeps the invocation failure on PassStat, the implement sub-step and the cycle summary", async () => {
    const implementResults = [CLEAN(), ERRORED()];
    const reviewVerdicts = [false, true];
    const executor: LLMExecutor = {
      invoke: vi.fn(async (req) => (req.stage === "implement" ? implementResults.shift()! : reviewResult(reviewVerdicts.shift()!))),
    };
    const ctx = makeContext({ issueTitle: "t", issueDescription: "d" }, executor);
    const reported: Step[] = [];
    const reporter: StepReporter = { report: async (s) => { reported.push(JSON.parse(JSON.stringify(s))); } };

    const out = await feedbackLoopStep.run(
      ctx,
      { workspaceDir: dir, issueTitle: "t", issueDescription: "d", maxIterations: 3 },
      reporter,
    );

    expect(out.approved).toBe(true);
    const [p1, p2] = out.passes as Array<Record<string, unknown>>;
    expect(p1).toMatchObject({ implementOutcome: "success", reviewApproved: false });
    expect(p1.implementFailureCode).toBeUndefined();
    expect(p2).toMatchObject({
      implementOutcome: "error",
      reviewApproved: true,
      implementFailureCode: "LLM_TERMINAL_ERROR",
      implementFailureMessage: "stream disconnected before completion",
    });

    const implement2 = reported.filter((s) => s.id === "implement.2" && s.status === "passed").pop();
    expect((implement2?.outputs as { invocationFailure?: { code: string } }).invocationFailure?.code).toBe("LLM_TERMINAL_ERROR");
    const implement1 = reported.filter((s) => s.id === "implement.1" && s.status === "passed").pop();
    expect((implement1?.outputs as { invocationFailure?: unknown }).invocationFailure).toBeUndefined();

    const summaries = readFileSync(join(dir, "ai-output", "cycle-summaries.jsonl"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; verdict: { approved: boolean; reason: string; summary?: string } });
    const s2 = summaries.find((s) => s.id === "feedback-loop.2")!;
    expect(s2.verdict).toMatchObject({ approved: true, reason: "approved" });
    expect(s2.verdict.summary).toContain("Implement invocation failed (LLM_TERMINAL_ERROR): stream disconnected before completion");
    const s1 = summaries.find((s) => s.id === "feedback-loop.1")!;
    expect(s1.verdict.summary).not.toContain("Implement invocation failed");
  });
});
