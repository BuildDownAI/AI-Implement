# Unapproved-Run Draft PRs & Honest Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run whose feedback loop never approves must open a draft PR with the reviewer feedback, send an honest failure callback (unsticking the ticket), run a post-mortem on hard `max_turns`, and be loud in logs/annotations — no more silent no-PR successes.

**Architecture:** Telemetry (turns/outcome/tool-trace) flows from the Claude CLI stream through the implement step into the feedback loop, which now reports *why* it terminated. The push step always runs and opens a draft PR when unapproved. `run-autonomous` derives the real outcome and always posts the callback; the orchestrator renders new failure codes into ticket comments and records the draft-PR URL.

**Tech Stack:** Node.js/TypeScript (ESM, `.js` import suffixes), Vitest, GitHub REST API, existing pipeline framework in `src/pipeline/`.

**Spec:** `docs/superpowers/specs/2026-07-22-unapproved-run-draft-pr-design.md`

## Global Constraints

- GHA job stays green on unapproved runs — `::warning::` annotation only, exit code 0 (user decision).
- Post-mortem fires ONLY on the hard `max_turns` CLI outcome (`subtype: "error_max_turns"`), never on a near-cap heuristic (user decision).
- Ticket transition reuses the existing `markImplementationFailed` provider verb — no new tracker states (user decision).
- New failure codes are exactly `"REVIEW_UNAPPROVED"` and `"MAX_TURNS_EXHAUSTED"`.
- Draft-PR fallback title prefix is exactly `[NEEDS REVIEW — unapproved] `.
- Autopsy comment file path is exactly `ai-output/comments/90-run-autopsy.md` under the workspace dir.
- All new/changed behavior is unit-tested with Vitest; tests live in `src/__tests__/`.
- Run `npm test` (vitest) and `npm run typecheck` (tsc --noEmit) before each commit claiming green.
- No changes to `workflows/*.yml` or `.github/workflows/*.yml` in this plan (no dual-copy concerns).

---

### Task 1: Tool trace + telemetry propagation through the implement step

**Files:**
- Modify: `src/pipeline/types.ts:97-104` (RunTelemetry)
- Modify: `src/pipeline/claude-stream.ts` (extractToolTrace, extractTelemetry)
- Modify: `src/pipeline/steps/implement.ts` (outputs + max_turns tolerance)
- Test: `src/__tests__/claude-stream.test.ts`, `src/__tests__/steps-implement.test.ts`

**Interfaces:**
- Consumes: existing `StreamEvent`, `summarizeToolInput` (private in claude-stream.ts — reuse internally).
- Produces:
  - `RunTelemetry.toolTrace?: string[]` (optional, entries like `"Bash npm test"`, capped at 200 + a `"… N more tool calls truncated"` tail entry).
  - `export function extractToolTrace(events: StreamEvent[], max?: number): string[]` in `claude-stream.ts`.
  - Implement step outputs gain `telemetry?: RunTelemetry`.
  - Implement step no longer throws when `telemetry.outcome === "max_turns"` even if exit code ≠ 0.

- [ ] **Step 1: Write failing tests for extractToolTrace + telemetry.toolTrace**

Append to `src/__tests__/claude-stream.test.ts`:

```typescript
describe("extractToolTrace", () => {
  const toolEvent = (name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });

  it("collects tool calls as 'name input-summary' entries", () => {
    const events = [
      toolEvent("Bash", { command: "npm test" }),
      toolEvent("Read", { file_path: "/src/app.ts" }),
      { type: "result", subtype: "success" },
    ];
    expect(extractToolTrace(events)).toEqual(["Bash npm test", "Read /src/app.ts"]);
  });

  it("caps entries and appends a truncation marker", () => {
    const events = Array.from({ length: 5 }, (_, i) => toolEvent("Bash", { command: `cmd${i}` }));
    const trace = extractToolTrace(events, 3);
    expect(trace).toHaveLength(4);
    expect(trace[3]).toBe("… 2 more tool calls truncated");
  });

  it("returns [] when there are no tool calls", () => {
    expect(extractToolTrace([{ type: "result", subtype: "success" }])).toEqual([]);
  });
});

describe("extractTelemetry toolTrace", () => {
  it("includes the tool trace in telemetry", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }] } },
      { type: "result", subtype: "success", num_turns: 3 },
    ];
    expect(extractTelemetry(events).toolTrace).toEqual(["Read /a"]);
  });
});
```

Add `extractToolTrace` to the existing import from `../pipeline/claude-stream.js` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: FAIL — `extractToolTrace` is not exported.

- [ ] **Step 3: Implement extractToolTrace and wire into extractTelemetry**

In `src/pipeline/types.ts`, add to `RunTelemetry` (after `tokensOut`):

```typescript
  /** Compact per-call tool trace ("ToolName input-summary"), capped; last entry may be a truncation marker. */
  toolTrace?: string[];
```

In `src/pipeline/claude-stream.ts`, below `summarizeToolInput`:

```typescript
const TOOL_TRACE_MAX = 200;

/**
 * Compact trace of every tool call in the session ("ToolName input-summary").
 * Retained at BOTH log levels so a max_turns post-mortem can see where the
 * turns went even when the run wasn't logged in stream mode. Capped to bound
 * memory; a final marker entry records how many calls were dropped.
 */
export function extractToolTrace(events: StreamEvent[], max = TOOL_TRACE_MAX): string[] {
  const trace: string[] = [];
  let dropped = 0;
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const msg = e.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      const entry = `${name} ${summarizeToolInput(block.input)}`.trimEnd();
      if (trace.length < max) trace.push(entry);
      else dropped++;
    }
  }
  if (dropped > 0) trace.push(`… ${dropped} more tool calls truncated`);
  return trace;
}
```

In `extractTelemetry`, add `toolTrace: extractToolTrace(events)` to **both** return objects (the no-result early return and the main return).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Write failing tests for implement-step telemetry passthrough and max_turns tolerance**

Append to `src/__tests__/steps-implement.test.ts` (follow the file's existing mock-executor pattern — it builds a context with a stubbed `llmExecutor.invoke`):

```typescript
  it("includes executor telemetry in outputs", async () => {
    const telemetry = {
      outcome: "success" as const, numTurns: 12, durationMs: 1000,
      costUsd: 0.5, tokensIn: 100, tokensOut: 50, toolTrace: ["Bash npm test"],
    };
    // Use this file's existing helper for building a context with a mocked
    // executor; set the mock to resolve with:
    // { stdout: "done", exitCode: 0, tokensUsed: 150, telemetry }
    const outputs = await implementStep.run(ctx, { workspaceDir: "/tmp/ws", prompt: "p" }, reporter);
    expect(outputs.telemetry).toEqual(telemetry);
  });

  it("does not throw on non-zero exit when the outcome is max_turns", async () => {
    const telemetry = {
      outcome: "max_turns" as const, numTurns: 50, durationMs: 1000,
      costUsd: null, tokensIn: null, tokensOut: null, toolTrace: [],
    };
    // executor mock resolves with { stdout: "", exitCode: 1, tokensUsed: 0, telemetry }
    const outputs = await implementStep.run(ctx, { workspaceDir: "/tmp/ws", prompt: "p" }, reporter);
    expect(outputs.telemetry?.outcome).toBe("max_turns");
  });
```

(Adapt `ctx`/`reporter` construction to the helpers already present in `steps-implement.test.ts` — read the file first; it already mocks `spawnSync` for `getChangedFiles`.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/steps-implement.test.ts`
Expected: FAIL — `outputs.telemetry` undefined; max_turns case throws.

- [ ] **Step 7: Implement in implement.ts**

In `src/pipeline/steps/implement.ts`:

Add to the imports: `import type { PipelineContext, StepModule, StepReporter, RunTelemetry } from "../types.js";` (extend the existing type import).

Change `ImplementOutputs`:

```typescript
interface ImplementOutputs extends Record<string, unknown> {
  filesChanged: string[];
  tokensUsed: number;
  exitCode: number;
  subagentCount: number;
  telemetry?: RunTelemetry;
}
```

Change the throw guard and return:

```typescript
    // A max_turns termination is a completed-but-capped pass, not an invocation
    // failure: the feedback loop needs the partial work + telemetry to run its
    // post-mortem and open a draft PR, so don't discard it by throwing.
    if (result.exitCode !== 0 && result.telemetry?.outcome !== "max_turns") {
      throw new Error(`LLM invocation failed with exit code ${result.exitCode}${formatLlmResultDetail(result)}`);
    }

    return {
      filesChanged: getChangedFiles(workspaceDir),
      tokensUsed: result.tokensUsed,
      exitCode: result.exitCode,
      // subagentCount is not observable from the CLI's stdout; when workUnits parallelism
      // is triggered, subagents run inside the single Claude session and are not reported
      // separately. This always returns 0 until the CLI exposes subagent metrics.
      subagentCount: 0,
      telemetry: result.telemetry,
    };
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/steps-implement.test.ts src/__tests__/claude-stream.test.ts src/__tests__/executor.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/pipeline/types.ts src/pipeline/claude-stream.ts src/pipeline/steps/implement.ts src/__tests__/claude-stream.test.ts src/__tests__/steps-implement.test.ts
git commit -m "feat(runner): propagate telemetry + tool trace through implement step; tolerate max_turns exit"
```

---

### Task 2: Feedback-loop termination reasons, pass stats, max_turns stop + post-mortem

**Files:**
- Modify: `src/pipeline/steps/feedback-loop.ts`
- Modify: `src/pipeline/steps/review.ts:38` (export `capDiff`)
- Test: `src/__tests__/steps-feedback-loop.test.ts`

**Interfaces:**
- Consumes: `implementStep` outputs incl. `telemetry?: RunTelemetry` (Task 1); `READ_ONLY_ALLOWED_TOOLS` from `./read-only-tools.js`; `capDiff` from `./review.js`.
- Produces (exported from `feedback-loop.ts`):

```typescript
export type TerminationReason = "approved" | "iterations_exhausted" | "review_error" | "max_turns";

export interface PassStat extends Record<string, unknown> {
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;   // RunTelemetry outcome or "unknown"
  costUsd: number | null;
  reviewApproved: boolean | null; // null when review never ran on this pass
}
```

  `FeedbackLoopOutputs` gains: `terminationReason: TerminationReason`, `passes: PassStat[]`, `postMortem?: string`. Existing `approved`, `iterations`, `finalFeedback` unchanged. Later tasks (pipeline-loader wiring, run-autonomous derivation) read exactly these field names.

- [ ] **Step 1: Export capDiff from review.ts**

In `src/pipeline/steps/review.ts:38` change `function capDiff(` to `export function capDiff(`.

- [ ] **Step 2: Write failing tests**

Append to `src/__tests__/steps-feedback-loop.test.ts` (uses the file's existing `makeContext`, `BASE_INPUTS`, `mockDiff`, `APPROVED_REVIEW`, `REJECTED_REVIEW`, `IMPLEMENT_OUTPUTS` helpers). Note the `DefaultPipelineContext` there is built without an executor; add a mock executor for the post-mortem tests:

```typescript
const MAX_TURNS_TELEMETRY = {
  outcome: "max_turns" as const, numTurns: 50, durationMs: 60000,
  costUsd: 2.5, tokensIn: 1000, tokensOut: 500,
  toolTrace: ["Bash npm test", "Read /src/app.ts"],
};

function makeContextWithExecutor(invoke: ReturnType<typeof vi.fn>): DefaultPipelineContext {
  return new DefaultPipelineContext(
    {
      jobId: 1, issueId: "issue-1", issueIdentifier: "ENG-1", issueTitle: "Test",
      issueDescription: "Description", nonce: "nonce", orchestratorUrl: "http://localhost:8080",
    },
    { invoke },
  );
}

describe("feedbackLoopStep termination reasons", () => {
  it("reports terminationReason=approved with per-pass stats", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({
      ...IMPLEMENT_OUTPUTS,
      telemetry: { outcome: "success", numTurns: 12, durationMs: 1, costUsd: 0.3, tokensIn: 1, tokensOut: 1, toolTrace: [] },
    });
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.terminationReason).toBe("approved");
    expect(outputs.passes).toEqual([
      { iteration: 1, implementTurns: 12, implementOutcome: "success", costUsd: 0.3, reviewApproved: true },
    ]);
  });

  it("reports terminationReason=iterations_exhausted when all reviews reject", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("iterations_exhausted");
    expect(outputs.passes).toHaveLength(3);
    expect(outputs.passes[0].reviewApproved).toBe(false);
  });

  it("reports terminationReason=review_error when the review step throws", async () => {
    vi.mocked(reviewStep.run).mockRejectedValueOnce(new Error("Prompt is too long"));

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("review_error");
    expect(outputs.iterations).toBe(1);
  });

  it("stops on max_turns, skips review, runs the post-mortem, and returns it", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({ ...IMPLEMENT_OUTPUTS, telemetry: MAX_TURNS_TELEMETRY });
    const invoke = vi.fn().mockResolvedValue({ stdout: "## Post-mortem\nRan out of turns wiring X.", exitCode: 0, tokensUsed: 10 });

    const outputs = await feedbackLoopStep.run(makeContextWithExecutor(invoke), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("max_turns");
    expect(outputs.iterations).toBe(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
    expect(outputs.postMortem).toContain("Ran out of turns");
    // Post-mortem is read-only and capped
    const call = invoke.mock.calls[0][0];
    expect(call.tools).toEqual(["Read", "Glob", "Grep", "Bash(curl *)"]);
    expect(call.maxTurns).toBe(15);
    expect(call.prompt).toContain("Bash npm test"); // tool trace embedded
  });

  it("post-mortem failure is non-fatal", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({ ...IMPLEMENT_OUTPUTS, telemetry: MAX_TURNS_TELEMETRY });
    const invoke = vi.fn().mockRejectedValue(new Error("boom"));

    const outputs = await feedbackLoopStep.run(makeContextWithExecutor(invoke), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.terminationReason).toBe("max_turns");
    expect(outputs.postMortem).toBeUndefined();
  });
});
```

Check `DefaultPipelineContext`'s constructor signature in `src/pipeline/context.ts` first — if the executor is not the second positional argument, adapt `makeContextWithExecutor` accordingly.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/steps-feedback-loop.test.ts`
Expected: FAIL — no `terminationReason`/`passes` in outputs.

- [ ] **Step 4: Implement in feedback-loop.ts**

In `src/pipeline/steps/feedback-loop.ts`:

Add imports:

```typescript
import type { PipelineContext, Step, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { READ_ONLY_ALLOWED_TOOLS } from "./read-only-tools.js";
import { capDiff } from "./review.js";
```

Add the exported types (see Interfaces block above) and extend `FeedbackLoopOutputs`:

```typescript
interface FeedbackLoopOutputs extends Record<string, unknown> {
  approved: boolean;
  iterations: number;
  finalFeedback: string;
  terminationReason: TerminationReason;
  passes: PassStat[];
  postMortem?: string;
}
```

Add the post-mortem helper (module-level, above `feedbackLoopStep`):

```typescript
const POST_MORTEM_MAX_TURNS = 15;

function buildPostMortemPrompt(params: {
  issueTitle: string;
  issueDescription: string;
  diff: string;
  telemetry: RunTelemetry;
  maxTurns: number;
}): string {
  const { issueTitle, issueDescription, diff, telemetry, maxTurns } = params;
  const trace = (telemetry.toolTrace ?? []).join("\n") || "(no tool trace captured)";
  return `An AI implementation session hit its turn cap (${telemetry.numTurns ?? "?"}/${maxTurns} turns) before completing. Write a concise post-mortem in markdown. You have read-only access to the workspace.

Answer, with headers:
1. **Where the turns went** — summarize the phases of work from the tool trace.
2. **What is complete** — based on the diff.
3. **What remains** — concrete missing pieces vs. the issue requirements.
4. **Why it likely didn't converge** — over-broad scope, missing prerequisites, thin context, or environment friction. Be specific.

Issue: ${issueTitle}

Description:
${issueDescription}

## Working-tree diff
\`\`\`diff
${capDiff(diff)}
\`\`\`

## Tool trace (chronological)
${trace}`;
}

/** Read-only post-mortem invocation. Non-fatal: returns null on any failure. */
async function runPostMortem(
  context: PipelineContext,
  params: { issueTitle: string; issueDescription: string; diff: string; telemetry: RunTelemetry; maxTurns: number; model: string; iteration: number; parentStepId: string },
  reporter: StepReporter,
): Promise<string | null> {
  const subStep: Step = {
    id: `post-mortem.${params.iteration}`,
    type: "custom",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    parent_step_id: params.parentStepId,
    inputs: { iteration: params.iteration, maxTurns: params.maxTurns },
    outputs: {},
    logs_url: null,
  };
  await reporter.report(subStep);
  try {
    const result = await context.llmExecutor.invoke({
      prompt: buildPostMortemPrompt(params),
      model: params.model,
      maxTurns: POST_MORTEM_MAX_TURNS,
      tools: READ_ONLY_ALLOWED_TOOLS,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`post-mortem invocation exited ${result.exitCode}`);
    }
    subStep.status = "passed";
    subStep.ended_at = new Date().toISOString();
    subStep.outputs = { length: result.stdout.length };
    await reporter.report(subStep);
    return result.stdout.trim();
  } catch (err) {
    subStep.status = "failed";
    subStep.ended_at = new Date().toISOString();
    subStep.outputs = { error: String(err) };
    await reporter.report(subStep);
    console.warn(`[feedback-loop] post-mortem failed (non-fatal): ${String(err)}`);
    return null;
  }
}
```

Rework the loop body in `feedbackLoopStep.run`. Declare alongside the existing state (`iteration`, `approved`, `feedback`):

```typescript
    let terminationReason: TerminationReason = "iterations_exhausted";
    const passes: PassStat[] = [];
    let postMortem: string | undefined;
```

After the implement sub-step succeeds (after the existing `await reporter.report(implementSubStep)` in the try block), add:

```typescript
      const implementTelemetry = implementOutputs.telemetry as RunTelemetry | undefined;
      const pass: PassStat = {
        iteration,
        implementTurns: implementTelemetry?.numTurns ?? null,
        implementOutcome: implementTelemetry?.outcome ?? "unknown",
        costUsd: implementTelemetry?.costUsd ?? null,
        reviewApproved: null,
      };
      passes.push(pass);

      const diff = getDiff(String(inputs.workspaceDir));

      // Hard max_turns: the pass ran out of budget mid-work. Reviewing or
      // re-implementing an over-scoped task just burns more passes — stop,
      // post-mortem where the turns went, and let the pipeline open a draft PR.
      if (implementTelemetry?.outcome === "max_turns") {
        terminationReason = "max_turns";
        feedback = `Implementation hit the ${effectiveMaxTurns}-turn cap before completing (${implementTelemetry.numTurns ?? "?"} turns used).`;
        postMortem =
          (await runPostMortem(
            context,
            {
              issueTitle: String(inputs.issueTitle),
              issueDescription: String(inputs.issueDescription),
              diff,
              telemetry: implementTelemetry,
              maxTurns: effectiveMaxTurns,
              model: resolvedReviewModel,
              iteration,
              parentStepId,
            },
            reporter,
          )) ?? undefined;
        break;
      }
```

(The existing `const diff = getDiff(...)` line between the implement and review sub-steps is replaced by the one above — don't compute it twice.)

In the review success path (after `approved = reviewOutputs.approved; feedback = reviewOutputs.feedback;`), add:

```typescript
        pass.reviewApproved = reviewOutputs.approved;
        if (approved) terminationReason = "approved";
```

In the review catch path, before `break`, replace `approved = false;` block tail with:

```typescript
        approved = false;
        feedback = `Review step failed and was skipped: ${String(err)}`;
        terminationReason = "review_error";
        break;
```

Also update the misleading log line in that catch (the pipeline now genuinely pushes a draft):

```typescript
        console.warn(
          `[feedback-loop] Review step failed on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
        );
```

Replace the final return with a loud exit:

```typescript
    if (!approved) {
      console.warn(
        `[feedback-loop] exited without approval (${terminationReason}) after ${iteration}/${effectiveMaxIterations} iteration(s). Final feedback: ${feedback || "(none)"}`,
      );
    }
    return { approved, iterations: iteration, finalFeedback: feedback, terminationReason, passes, ...(postMortem ? { postMortem } : {}) };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/steps-feedback-loop.test.ts src/__tests__/steps-review.test.ts`
Expected: PASS (pre-existing tests must still pass — they don't assert on the new fields).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pipeline/steps/feedback-loop.ts src/pipeline/steps/review.ts src/__tests__/steps-feedback-loop.test.ts
git commit -m "feat(runner): feedback-loop termination reasons, pass stats, max_turns post-mortem"
```

---

### Task 3: Draft-PR push path + pipeline wiring

**Files:**
- Modify: `src/pipeline/steps/push.ts`
- Modify: `src/pipeline/pipeline-loader.ts:151-165` (push wiring), `:180-192` (post-push-review skip)
- Test: `src/__tests__/steps-push.test.ts`, `src/__tests__/pipeline-loader.test.ts`

**Interfaces:**
- Consumes: `feedback-loop` outputs `approved`, `terminationReason`, `iterations`, `finalFeedback`, `passes`, `postMortem` (Task 2 names, read via `ctx.getOutputs("feedback-loop")`).
- Produces:
  - `PushInputs` gains `draft?: boolean` and `reviewSummary?: ReviewSummary` where:

```typescript
export interface ReviewSummary extends Record<string, unknown> {
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{ iteration: number; implementTurns: number | null; implementOutcome: string; costUsd: number | null; reviewApproved: boolean | null }>;
  postMortem?: string;
}
```

  - `PushOutputs` gains `draft: boolean` (true when the PR was created as a draft).
  - The fallback title prefix constant: `export const UNAPPROVED_TITLE_PREFIX = "[NEEDS REVIEW — unapproved] ";`
  - Pipeline: `push` no longer has a `skip`; `post-push-review` also skips when `feedback-loop.approved !== true`.

- [ ] **Step 1: Write failing push-step tests**

Append to `src/__tests__/steps-push.test.ts` (reuses `makeContext`, `BASE_INPUTS`, `mockGitSuccess`, `spawnResult` from the file):

```typescript
const REVIEW_SUMMARY = {
  terminationReason: "iterations_exhausted",
  iterations: 3,
  finalFeedback: "Missing tests for the retry path.",
  passes: [
    { iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewApproved: false },
  ],
  postMortem: "## Post-mortem\nScope too broad.",
};

describe("pushStep draft PRs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("creates a draft PR with an unapproved section in the body", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(true);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.draft).toBe(true);
    expect(body.body).toContain("Automated review did not approve");
    expect(body.body).toContain("Missing tests for the retry path.");
    expect(body.body).toContain("iterations_exhausted");
    expect(body.body).toContain("Post-mortem");
  });

  it("falls back to a titled normal PR when the draft flag is rejected (422, no existing PR)", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      // draft create → 422
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "draft not supported" } as Response)
      // list open PRs → none
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [], text: async () => "" } as Response)
      // retry without draft → created
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/10", number: 10 }),
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, prTitle: "ENG-42: Test", draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
    expect(outputs.prNumber).toBe(10);
    const [, retryInit] = vi.mocked(fetch).mock.calls[2];
    const retryBody = JSON.parse(String(retryInit?.body));
    expect(retryBody.draft).toBeUndefined();
    expect(retryBody.title).toBe("[NEEDS REVIEW — unapproved] ENG-42: Test");
  });

  it("still resolves an already-open PR on 422 when drafting", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "exists" } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => [{ html_url: "https://github.com/acme/app/pull/8", number: 8 }],
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.prNumber).toBe(8);
  });

  it("non-draft pushes send no draft flag and no unapproved section", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.draft).toBe(false);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.draft).toBeUndefined();
    expect(body.body).not.toContain("Automated review did not approve");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/steps-push.test.ts`
Expected: FAIL — `outputs.draft` undefined, no draft flag in body.

- [ ] **Step 3: Implement in push.ts**

In `src/pipeline/steps/push.ts`:

Add the exported `ReviewSummary` interface and the constant (near the top, after the existing constants):

```typescript
export const UNAPPROVED_TITLE_PREFIX = "[NEEDS REVIEW — unapproved] ";

export interface ReviewSummary extends Record<string, unknown> {
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{ iteration: number; implementTurns: number | null; implementOutcome: string; costUsd: number | null; reviewApproved: boolean | null }>;
  postMortem?: string;
}
```

Extend `PushInputs` with `draft?: boolean; reviewSummary?: ReviewSummary;` and `PushOutputs` with `draft: boolean;`.

In `run`, derive `const draft = inputs.draft === true;` and pass it through:

```typescript
    const pr = await span("pr-create", async () =>
      createOrFindPullRequest({ repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody, draft }),
    );
    return { prUrl: pr.url, prNumber: pr.number, branchPushed: true, commitSha, draft: pr.draft };
```

Change `CreatePrInputs` to add `draft: boolean;` and rework `createOrFindPullRequest` to return `{ url: string; number: number; draft: boolean }`:

```typescript
async function createOrFindPullRequest(
  inputs: CreatePrInputs,
): Promise<{ url: string; number: number; draft: boolean }> {
  const { repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody, draft } = inputs;

  const create = async (title: string, asDraft: boolean): Promise<Response> =>
    fetch(`https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${githubToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, head: branchName, base: baseBranch, body: prBody, ...(asDraft ? { draft: true } : {}) }),
    });

  const parseCreated = async (res: Response, asDraft: boolean): Promise<{ url: string; number: number; draft: boolean }> => {
    const pr = (await res.json()) as { html_url?: unknown; number?: unknown };
    if (typeof pr.html_url !== "string" || typeof pr.number !== "number") {
      throw new Error("Unexpected PR creation response shape from GitHub API");
    }
    return { url: pr.html_url, number: pr.number, draft: asDraft };
  };

  const prRes = await create(prTitle, draft);
  if (prRes.ok) return parseCreated(prRes, draft);

  if (prRes.status === 422) {
    // Ambiguous: either the PR already exists, or the repo plan rejects draft
    // PRs. Check for an existing open PR first (existing behavior), then — if
    // we were drafting — retry as a clearly-titled normal PR so the work is
    // never vaporized on Free-plan private repos.
    const listRes = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls?head=${repoOwner}:${branchName}&state=open`,
      { headers: { Authorization: `Bearer ${githubToken}` } },
    );
    if (!listRes.ok) {
      const listBody = await listRes.text().catch(() => "");
      throw new Error(`PR already exists (422) but listing open PRs failed with HTTP ${listRes.status}: ${listBody}`);
    }
    const prs = (await listRes.json()) as Array<{ html_url?: unknown; number?: unknown }>;
    if (prs.length > 0) {
      const existing = prs[0];
      if (typeof existing.html_url === "string" && typeof existing.number === "number") {
        return { url: existing.html_url, number: existing.number, draft: false };
      }
    }
    if (draft) {
      const retryRes = await create(`${UNAPPROVED_TITLE_PREFIX}${prTitle}`, false);
      if (retryRes.ok) return parseCreated(retryRes, false);
      const retryBody = await retryRes.text().catch(() => "");
      throw new Error(`Draft PR rejected (422) and non-draft fallback failed with HTTP ${retryRes.status}: ${retryBody}`);
    }
    throw new Error(`PR already exists (422) but no open PR found for branch ${branchName}`);
  }

  const body = await prRes.text().catch(() => "");
  throw new Error(`PR creation failed with HTTP ${prRes.status}: ${body}`);
}
```

Add the unapproved section to `buildPullRequestBody`. Change its signature to `(context, inputs, changedFilesSummary)` (unchanged) and inside, before the final `return`, build the section and prepend it:

```typescript
  const unapprovedSection = buildUnapprovedSection(inputs.reviewSummary as ReviewSummary | undefined, inputs.draft === true);
```

and change the returned array to start with `...(unapprovedSection ? [unapprovedSection, ""] : []),`. Add the helper:

```typescript
function buildUnapprovedSection(summary: ReviewSummary | undefined, draft: boolean): string | null {
  if (!summary) return null;
  const passRows = summary.passes
    .map((p) => {
      const cost = p.costUsd != null ? `$${p.costUsd.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${cost} | ${review} |`;
    })
    .join("\n");
  return [
    "## ⚠️ Automated review did not approve",
    "",
    `This PR was opened ${draft ? "as a draft" : "for human review"} because the AI-Implement review loop ended without approval (reason: \`${summary.terminationReason}\` after ${summary.iterations} iteration(s)).`,
    "",
    "**Reviewer's final feedback:**",
    "",
    ...summary.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "**Run stats:**",
    "",
    "| Pass | Implement outcome | Turns | Cost | Review |",
    "|---|---|---|---|---|",
    passRows,
    ...(summary.postMortem ? ["", "<details><summary><strong>Post-mortem</strong></summary>", "", summary.postMortem, "", "</details>"] : []),
    "",
    "_Preflight and verify hooks were skipped for this unapproved run._",
  ].join("\n");
}
```

- [ ] **Step 4: Run push tests to verify they pass**

Run: `npx vitest run src/__tests__/steps-push.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing pipeline-loader tests**

Append to `src/__tests__/pipeline-loader.test.ts` (read the file's existing helpers for loading the default pipeline and faking context outputs — it already tests the current skip conditions; those existing assertions about push skipping on unapproved must be **updated**, not duplicated):

```typescript
describe("unapproved wiring", () => {
  it("push never skips, and wires draft + reviewSummary from feedback-loop outputs", () => {
    // load DEFAULT pipeline via the file's existing loader helper
    const push = steps.find((s) => s.id === "push")!;
    expect(push.skip).toBeUndefined();

    // fake context where feedback-loop was unapproved (use the file's context helper)
    ctx.setOutputs("feedback-loop", {
      approved: false, iterations: 3, finalFeedback: "nope",
      terminationReason: "iterations_exhausted",
      passes: [{ iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 1, reviewApproved: false }],
    });
    const inputs = ctx.resolveInputs(push.inputs);
    expect(inputs.draft).toBe(true);
    expect((inputs.reviewSummary as { finalFeedback: string }).finalFeedback).toBe("nope");
  });

  it("push wires draft=false and no reviewSummary when approved", () => {
    ctx.setOutputs("feedback-loop", { approved: true, iterations: 1, finalFeedback: "ok", terminationReason: "approved", passes: [] });
    const inputs = ctx.resolveInputs(push.inputs);
    expect(inputs.draft).toBe(false);
    expect(inputs.reviewSummary).toBeUndefined();
  });

  it("post-push-review skips when feedback-loop was not approved", () => {
    const ppr = steps.find((s) => s.id === "post-push-review")!;
    ctx.setOutputs("feedback-loop", { approved: false });
    ctx.setOutputs("push", { branchPushed: true, prNumber: 9 });
    expect(ppr.skip!(ctx)).toBe(true);
  });
});
```

Also update any existing test asserting `push.skip(ctx) === true` for unapproved feedback-loop — push has no skip anymore. `preflight` and `verify` skip tests are unchanged.

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/pipeline-loader.test.ts`
Expected: FAIL — push still has a skip; no draft wiring.

- [ ] **Step 7: Implement pipeline-loader wiring**

In `src/pipeline/pipeline-loader.ts`, replace the `case "push":` block:

```typescript
    case "push":
      // Push always runs after the feedback loop: unapproved work ships as a
      // draft PR (with the reviewer feedback in the body) instead of being
      // silently discarded. "Nothing to commit" remains a loud failure.
      return {
        ...step,
        inputs: (ctx: PipelineContext) => {
          const fb = ctx.getOutputs("feedback-loop");
          const approved = fb.approved === true;
          return {
            workspaceDir: ctx.getOutputs("clone").workspaceDir,
            repoOwner: ctx.getOutputs("clone").repoOwner,
            repoRepo: ctx.getOutputs("clone").repoRepo,
            githubToken: ctx.getOutputs("clone").githubToken,
            branchName: buildIssueBranchName(ctx.data.issueIdentifier, ctx.data.issueTitle, ctx.data.branchPrefix),
            baseBranch: ctx.getOutputs("clone").branch,
            prTitle: `${ctx.data.issueIdentifier}: ${ctx.data.issueTitle}`,
            sensitiveFiles: ctx.data.sensitiveFiles,
            draft: !approved,
            reviewSummary: approved
              ? undefined
              : {
                  terminationReason: typeof fb.terminationReason === "string" ? fb.terminationReason : "unknown",
                  iterations: typeof fb.iterations === "number" ? fb.iterations : 0,
                  finalFeedback: typeof fb.finalFeedback === "string" ? fb.finalFeedback : "",
                  passes: Array.isArray(fb.passes) ? fb.passes : [],
                  ...(typeof fb.postMortem === "string" ? { postMortem: fb.postMortem } : {}),
                },
          };
        },
      };
```

And extend `case "post-push-review":`'s skip:

```typescript
        skip: (ctx: PipelineContext) => {
          // Never run further review/force-push cycles against an unapproved
          // draft — the review budget is already exhausted.
          if (ctx.getOutputs("feedback-loop").approved !== true) return true;
          const pushOutputs = ctx.getOutputs("push");
          return pushOutputs.branchPushed !== true || !pushOutputs.prNumber;
        },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/pipeline-loader.test.ts src/__tests__/steps-push.test.ts src/__tests__/default-pipeline.test.ts src/__tests__/pipeline-runner.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/pipeline/steps/push.ts src/pipeline/pipeline-loader.ts src/__tests__/steps-push.test.ts src/__tests__/pipeline-loader.test.ts
git commit -m "feat(runner): always push; open draft PR with review feedback when unapproved"
```

---

### Task 4: Honest outcome derivation, autopsy comment, callback always sent, GHA warning

**Files:**
- Create: `src/run-autopsy.ts`
- Modify: `src/run-autonomous.ts:394-407` (outcome derivation) and the `finally` block
- Modify: `src/runner-result.ts:60-63` (delete skip branch)
- Test: `src/__tests__/run-autopsy.test.ts` (new), `src/__tests__/run-autonomous.test.ts`, `src/__tests__/runner-result.test.ts`

**Interfaces:**
- Consumes: `feedback-loop` outputs (Task 2 names) and `push` outputs (`prUrl`, `draft`) via `context.getOutputs`; `postRunnerResult` (existing — already forwards `prUrl`/`failureCode` whenever set, on any outcome).
- Produces (in `src/run-autopsy.ts`):

```typescript
export interface RunAutopsy {
  issueIdentifier: string;
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{ iteration: number; implementTurns: number | null; implementOutcome: string; costUsd: number | null; reviewApproved: boolean | null }>;
  postMortem?: string;
  prUrl?: string;
}
export function formatRunAutopsy(a: RunAutopsy): string;          // markdown
export function writeRunAutopsy(workspaceDir: string, a: RunAutopsy): void; // best-effort, never throws
```

- Later tasks rely on: failure callbacks carrying `failureCode: "REVIEW_UNAPPROVED" | "MAX_TURNS_EXHAUSTED"` and `prUrl` (Task 5 renders them).

- [ ] **Step 1: Write failing run-autopsy tests**

Create `src/__tests__/run-autopsy.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, type RunAutopsy } from "../run-autopsy.js";

const AUTOPSY: RunAutopsy = {
  issueIdentifier: "DF-6",
  terminationReason: "iterations_exhausted",
  iterations: 3,
  finalFeedback: "Missing provider wiring.",
  passes: [{ iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewApproved: false }],
  postMortem: "## Post-mortem\nScope too broad.",
  prUrl: "https://github.com/acme/app/pull/9",
};

describe("formatRunAutopsy", () => {
  it("renders reason, stats, feedback, post-mortem, and PR link", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain("DF-6");
    expect(md).toContain("iterations_exhausted");
    expect(md).toContain("3 iteration(s)");
    expect(md).toContain("Missing provider wiring.");
    expect(md).toContain("| 1 | success | 98 | $3.21 | rejected |");
    expect(md).toContain("Post-mortem");
    expect(md).toContain("https://github.com/acme/app/pull/9");
  });

  it("notes when no PR could be opened", () => {
    const md = formatRunAutopsy({ ...AUTOPSY, prUrl: undefined });
    expect(md).toContain("No PR could be opened");
  });
});

describe("writeRunAutopsy", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes ai-output/comments/90-run-autopsy.md", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    writeRunAutopsy(dir, AUTOPSY);
    const path = join(dir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("DF-6");
  });

  it("never throws on an unwritable directory", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    expect(() => writeRunAutopsy("/nonexistent-root-path/nope", AUTOPSY)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/run-autopsy.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement src/run-autopsy.ts**

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunAutopsy {
  issueIdentifier: string;
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{
    iteration: number;
    implementTurns: number | null;
    implementOutcome: string;
    costUsd: number | null;
    reviewApproved: boolean | null;
  }>;
  postMortem?: string;
  prUrl?: string;
}

/** Markdown autopsy posted to the ticket via the ai-output/comments plumbing. */
export function formatRunAutopsy(a: RunAutopsy): string {
  const passRows = a.passes
    .map((p) => {
      const cost = p.costUsd != null ? `$${p.costUsd.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${cost} | ${review} |`;
    })
    .join("\n");
  return [
    `## 🔎 Run autopsy — ${a.issueIdentifier}`,
    "",
    `The implementation run ended **without review approval** (reason: \`${a.terminationReason}\`) after ${a.iterations} iteration(s).`,
    "",
    a.prUrl
      ? `The work so far is preserved in a draft PR: ${a.prUrl}`
      : "No PR could be opened (no code changes were produced).",
    "",
    "**Reviewer's final feedback:**",
    "",
    ...a.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "| Pass | Implement outcome | Turns | Cost | Review |",
    "|---|---|---|---|---|",
    passRows,
    ...(a.postMortem ? ["", a.postMortem] : []),
  ].join("\n");
}

/**
 * Best-effort: the autopsy is diagnostic, never worth failing the run over.
 * Written where collectRunnerComments() picks it up for the ticket callback.
 */
export function writeRunAutopsy(workspaceDir: string, a: RunAutopsy): void {
  try {
    const dir = join(workspaceDir, "ai-output", "comments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "90-run-autopsy.md"), formatRunAutopsy(a), "utf-8");
  } catch (err) {
    console.warn(`[run-autopsy] write failed (non-fatal): ${String(err)}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/run-autopsy.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for outcome derivation and callback-always**

First read `src/__tests__/run-autonomous.test.ts` to reuse its env/mock scaffolding (it stubs env vars and injects `reporter`/`llmExecutor`/`pipeline`/`fetchImpl` via `RunAutonomousOptions`). Add tests that run `runAutonomous` with a stub pipeline whose steps set `feedback-loop` and `push` outputs, capturing the `fetchImpl` POST to `/runner/result`:

```typescript
  it("reports failure with REVIEW_UNAPPROVED and the draft PR url when the loop never approved", async () => {
    // stub pipeline: a single step that sets outputs
    //   feedback-loop → { approved: false, iterations: 3, finalFeedback: "nope",
    //                     terminationReason: "iterations_exhausted", passes: [] }
    //   push          → { prUrl: "https://github.com/o/r/pull/9", prNumber: 9, branchPushed: true, draft: true }
    // run with callbackUrl/RUN_TOKEN env so postRunnerResult fires (see file's existing callback tests)
    const result = await runAutonomous({ ...opts });
    expect(result.exitCode).toBe(0); // job stays green — warning only
    const call = capturedResultPost(); // helper per file conventions
    expect(call.outcome).toBe("failure");
    expect(call.failureCode).toBe("REVIEW_UNAPPROVED");
    expect(call.failureReason).toContain("iterations_exhausted");
    expect(call.prUrl).toBe("https://github.com/o/r/pull/9");
  });

  it("uses MAX_TURNS_EXHAUSTED when terminationReason is max_turns", async () => {
    // same but terminationReason: "max_turns"
    expect(call.failureCode).toBe("MAX_TURNS_EXHAUSTED");
  });

  it("writes the autopsy comment file on unapproved runs", async () => {
    // workspaceDir = mkdtemp; after run, expect
    // <ws>/ai-output/comments/90-run-autopsy.md to exist and contain "nope"
  });

  it("still reports plain success with prUrl when approved", async () => {
    // feedback-loop approved: true, push prUrl set → outcome success, no failureCode
  });
```

And in `src/__tests__/runner-result.test.ts`, find and update the test asserting the implementation-success-no-PR **skip** — it must now assert the callback **is** sent (the guard moves to run-autonomous, which never sends success without a PR):

```typescript
  it("sends the callback even when an implementation success has no prUrl", async () => {
    // existing scaffolding: callbackUrl + RUN_TOKEN set, fetch mocked
    await postRunnerResult({ workspaceDir: "/tmp", phase: "implementation", outcome: "success", callbackUrl: "https://cb", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/run-autonomous.test.ts src/__tests__/runner-result.test.ts`
Expected: FAIL — success is reported unconditionally; skip branch still active.

- [ ] **Step 7: Implement derivation in run-autonomous.ts and remove the skip in runner-result.ts**

In `src/runner-result.ts`, delete lines 60-63 (the `if (params.phase === "implementation" && params.outcome === "success" && !params.prUrl)` block). Nothing else changes — `prUrl`, `failureCode`, `failureReason` are already forwarded whenever set.

In `src/run-autonomous.ts`, add the import:

```typescript
import { writeRunAutopsy } from "./run-autopsy.js";
```

Replace the success-reporting block (lines 397-407) inside `try`:

```typescript
    await runWithTiming(timing, () => runner.run(pipeline, context, reporter));
    const fbOutputs = context.getOutputs("feedback-loop");
    const pushOutputs = context.getOutputs("push");
    const prUrl = typeof pushOutputs.prUrl === "string" ? pushOutputs.prUrl : undefined;
    const approved = fbOutputs.approved === true;

    if (approved && prUrl) {
      await postRunnerResult({
        workspaceDir,
        phase: runnerPhase,
        outcome: "success",
        prUrl,
        callbackUrl,
        fetchImpl: opts.fetchImpl,
      });
      return { exitCode: 0 };
    }

    // The pipeline completed mechanically but the review loop never approved
    // (or push produced no PR). This is NOT a success: report a coded failure
    // so the ticket is updated and notifications fire, leave a run autopsy for
    // the ticket, and flag the GHA run — but keep the job green (warning only).
    const terminationReason =
      typeof fbOutputs.terminationReason === "string" ? fbOutputs.terminationReason : "unknown";
    const iterations = typeof fbOutputs.iterations === "number" ? fbOutputs.iterations : 0;
    const finalFeedback = typeof fbOutputs.finalFeedback === "string" ? fbOutputs.finalFeedback : "";
    const failureCode = terminationReason === "max_turns" ? "MAX_TURNS_EXHAUSTED" : "REVIEW_UNAPPROVED";
    const failureReason =
      `Automated review did not approve (${terminationReason} after ${iterations} iteration(s)). ` +
      finalFeedback.slice(0, 500);

    writeRunAutopsy(workspaceDir, {
      issueIdentifier,
      terminationReason,
      iterations,
      finalFeedback,
      passes: Array.isArray(fbOutputs.passes) ? (fbOutputs.passes as RunAutopsyPasses) : [],
      postMortem: typeof fbOutputs.postMortem === "string" ? fbOutputs.postMortem : undefined,
      prUrl,
    });
    console.warn(
      `::warning::AI-Implement: review did not approve after ${iterations} iteration(s) (${terminationReason}) — ` +
        (prUrl ? `draft PR opened: ${prUrl}` : "no PR opened"),
    );
    await postRunnerResult({
      workspaceDir,
      phase: runnerPhase,
      outcome: "failure",
      failureCode,
      failureReason,
      prUrl,
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
```

Add the type alias near the top of the file (after imports):

```typescript
type RunAutopsyPasses = Array<{
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;
  costUsd: number | null;
  reviewApproved: boolean | null;
}>;
```

Check `postRunnerResult`'s params type accepts `prUrl` alongside `outcome: "failure"` — it does (independent optional fields).

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/run-autonomous.test.ts src/__tests__/runner-result.test.ts src/__tests__/run-autonomous-config.test.ts src/__tests__/integration-callback.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/run-autopsy.ts src/run-autonomous.ts src/runner-result.ts src/__tests__/run-autopsy.test.ts src/__tests__/run-autonomous.test.ts src/__tests__/runner-result.test.ts
git commit -m "feat(runner): honest outcome derivation, run autopsy comment, callback always sent, GHA warning"
```

---

### Task 5: Orchestrator — render new failure codes, record draft-PR URL on the job

**Files:**
- Modify: `src/runner-callback.ts:59-70` (formatFailureComment) and `:195-205` (implementation-failure branch)
- Test: `src/__tests__/runner-callback.test.ts`

**Interfaces:**
- Consumes: failure callbacks with `failureCode: "REVIEW_UNAPPROVED" | "MAX_TURNS_EXHAUSTED"`, `failureReason`, optional `prUrl` (Task 4); existing `renderClassification`/`TROUBLESHOOTING_URL`; existing `updateJobPrUrl`, `getJobByDispatchId` (already imported in the file).
- Produces: `formatFailureComment(failureCode: string | undefined, failureReason: string | undefined, prUrl?: string): string` — signature gains the optional `prUrl` third parameter (only call site is in this same file).

- [ ] **Step 1: Write failing tests**

Append to `src/__tests__/runner-callback.test.ts` (reuse the file's existing scaffolding for minting run tokens and invoking `handleRunnerResult` with a mock provider):

```typescript
describe("unapproved-run failure codes", () => {
  it("formatFailureComment renders REVIEW_UNAPPROVED with the draft PR link", () => {
    const comment = formatFailureComment("REVIEW_UNAPPROVED", "Automated review did not approve (iterations_exhausted after 3 iteration(s)). Missing tests.", "https://github.com/o/r/pull/9");
    expect(comment).toContain("without review approval");
    expect(comment).toContain("https://github.com/o/r/pull/9");
    expect(comment).toContain("Missing tests.");
    expect(comment).toContain("**Next step:**");
  });

  it("formatFailureComment renders MAX_TURNS_EXHAUSTED distinctly", () => {
    const comment = formatFailureComment("MAX_TURNS_EXHAUSTED", "hit the cap", undefined);
    expect(comment).toContain("turn cap");
    expect(comment).toContain("No PR could be opened");
  });

  it("unknown failureCode still falls through to the generic summary", () => {
    expect(formatFailureComment("SOMETHING_NEW", "boom", undefined)).toContain("boom");
  });

  it("records the draft PR url on the job for an implementation failure", async () => {
    // mint token for phase "implementation"; body:
    // { phase: "implementation", outcome: "failure", failureCode: "REVIEW_UNAPPROVED",
    //   failureReason: "nope", prUrl: "https://github.com/o/r/pull/9", comments: [] }
    // assert (per the file's job-store conventions) that the job row's prUrl
    // was updated to the draft URL, and provider.markImplementationFailed was
    // called with a comment containing the draft URL.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/runner-callback.test.ts`
Expected: FAIL — generic rendering only; no prUrl parameter; job prUrl not recorded.

- [ ] **Step 3: Implement in runner-callback.ts**

Replace `formatFailureComment`:

```typescript
export function formatFailureComment(
  failureCode: string | undefined,
  failureReason: string | undefined,
  prUrl?: string,
): string {
  let c: Classification;
  if (failureCode === "SENSITIVE_FILES_BLOCKED") {
    c = {
      summary: "🔒 Blocked by security guardrail.",
      detail: failureReason ?? "Sensitive files detected in staged changes.",
      remediation: "Remove or .gitignore the flagged files, then re-run.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  } else if (failureCode === "REVIEW_UNAPPROVED" || failureCode === "MAX_TURNS_EXHAUSTED") {
    const cause =
      failureCode === "MAX_TURNS_EXHAUSTED"
        ? "the implementation hit its turn cap before completing"
        : "the automated reviewer did not approve within the allotted iterations";
    c = {
      summary: `🟡 Implementation finished without review approval — ${cause}.`,
      detail: [
        prUrl
          ? `The work so far is preserved in a draft PR: ${prUrl}`
          : "No PR could be opened (no code changes were produced).",
        failureReason ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      remediation:
        "Review the draft PR and the run autopsy comment. Likely causes: over-broad issue scope, missing prerequisites, or thin context — split the ticket or add context, then re-dispatch.",
      docsUrl: TROUBLESHOOTING_URL,
    };
  } else {
    c = { summary: failureReason ?? "Unspecified failure." };
  }
  return renderClassification(c);
}
```

Update the implementation-failure branch (around line 195) to pass `prUrl` and record it on the job:

```typescript
    } else if (input.body.phase === "implementation") {
      try {
        await provider.markImplementationFailed(
          claims.issueId,
          mappingTeamKey,
          formatFailureComment(input.body.failureCode, input.body.failureReason, input.body.prUrl),
        );
      } catch (err) {
        warn("markImplementationFailed", err);
      }
      // A coded unapproved failure still carries a draft PR — link it on the
      // job row so the admin UI and merge-detection can see it.
      if (typeof input.body.prUrl === "string" && input.body.prUrl) {
        const job = getJobByDispatchId(claims.dispatchId);
        if (job) updateJobPrUrl(job.id, input.body.prUrl);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/runner-callback.test.ts src/__tests__/runner-callback-routes.test.ts src/__tests__/completion-classification.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/runner-callback.ts src/__tests__/runner-callback.test.ts
git commit -m "feat(orchestrator): render REVIEW_UNAPPROVED/MAX_TURNS_EXHAUSTED; record draft PR url on job"
```

---

### Task 6: Timing summary — skipped steps + run disposition line

**Files:**
- Modify: `src/pipeline/timing.ts` (TimingRecord, TimingStepReporter, formatSummary)
- Modify: `src/run-autonomous.ts` (track disposition; pass to formatSummary in `finally`)
- Test: `src/__tests__/timing.test.ts`

**Interfaces:**
- Consumes: `Step.status === "skipped"` reports (the runner already emits these — `src/pipeline/runner.ts:73-85`).
- Produces:
  - `TimingRecord` gains `skipped?: boolean`.
  - `formatSummary(collector, identifier, disposition?: string)` — optional third parameter; when set, appends a final line `[timing]   outcome: <disposition>`.

- [ ] **Step 1: Write failing tests**

Append to `src/__tests__/timing.test.ts` (follow the file's existing patterns for building a collector/reporter and asserting on `formatSummary` output):

```typescript
describe("skipped steps and disposition", () => {
  it("records skipped steps and lists them in the summary", async () => {
    const collector = new TimingCollector("summary");
    const reporter = new TimingStepReporter(new NoopStepReporter(), collector);
    await reporter.report({
      id: "preflight", type: "preflight", status: "skipped",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      parent_step_id: null, inputs: {}, outputs: {}, logs_url: null,
    });
    const out = formatSummary(collector, "ENG-1");
    expect(out).toContain("preflight");
    expect(out).toContain("skipped");
  });

  it("appends the disposition line when provided", () => {
    const collector = new TimingCollector("summary");
    collector.record({ label: "push", parentId: null, ms: 1000, kind: "step" });
    const out = formatSummary(collector, "ENG-1", "draft PR #9 — review unapproved after 3/3 iterations (iterations_exhausted)");
    expect(out).toContain("outcome: draft PR #9 — review unapproved after 3/3 iterations (iterations_exhausted)");
  });

  it("skipped steps are never flagged dominant", async () => {
    const collector = new TimingCollector("summary");
    collector.record({ label: "clone", parentId: null, ms: 50, kind: "step" });
    collector.record({ label: "verify", parentId: null, ms: 0, kind: "step", skipped: true });
    const out = formatSummary(collector, "ENG-1");
    expect(out).toContain("clone");
    expect(out.split("\n").find((l) => l.includes("verify"))).toContain("skipped");
    expect(out.split("\n").find((l) => l.includes("verify"))).not.toContain("dominant");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/timing.test.ts`
Expected: FAIL — skipped steps not recorded; no third parameter.

- [ ] **Step 3: Implement in timing.ts**

Add to `TimingRecord`:

```typescript
  /** True when the step was skipped (rendered as "skipped", excluded from dominant). */
  skipped?: boolean;
```

In `TimingStepReporter.report`, extend the terminal-status branch:

```typescript
    } else if (step.status === "passed" || step.status === "failed") {
      // ... existing body unchanged ...
    } else if (step.status === "skipped") {
      this.collector.record({
        label: step.id,
        parentId: step.parent_step_id,
        ms: 0,
        kind: "step",
        skipped: true,
      });
    }
```

In `formatSummary`:
- Exclude skipped records from the `dominant` reduction: `const dominant = topLevel.filter((r) => !r.skipped).reduce(...)` (keep the same reduce body).
- Render skipped rows: inside the `for (const step of topLevel)` loop, replace the push with:

```typescript
    const duration = step.skipped ? "skipped" : formatDuration(step.ms);
    lines.push(`${PREFIX}   ${step.label.padEnd(18)} ${duration.padStart(7)}${mark}`);
```

  (compute `mark` only for non-skipped steps: `const mark = !step.skipped && topLevel.length > 1 && step === dominant ? "   ⚠ dominant" : "";`)
- Add the third parameter and final line:

```typescript
export function formatSummary(collector: TimingCollector, identifier: string, disposition?: string): string {
  // ... existing body ...
  if (disposition) lines.push(`${PREFIX}   outcome: ${disposition}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Wire disposition in run-autonomous.ts**

Declare before the `try` (near `const context = ...`):

```typescript
  let disposition: string | undefined;
```

Set it in the success branch of Task 4's derivation:

```typescript
      disposition = `PR ${prUrl} (approved after ${typeof fbOutputs.iterations === "number" ? fbOutputs.iterations : "?"} iteration(s))`;
```

and in the unapproved branch (after computing `terminationReason`/`iterations`):

```typescript
    disposition = `${prUrl ? `draft PR ${prUrl}` : "no PR"} — review unapproved after ${iterations} iteration(s) (${terminationReason})`;
```

and in the `catch` block (after the `console.error`):

```typescript
    disposition = `failed: ${err instanceof Error ? err.message : String(err)}`;
```

In the `finally` block, pass it through:

```typescript
      if (timing.records().length > 0) {
        console.error(formatSummary(timing, issueIdentifier, disposition));
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/timing.test.ts src/__tests__/run-autonomous.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pipeline/timing.ts src/run-autonomous.ts src/__tests__/timing.test.ts
git commit -m "feat(runner): timing summary lists skipped steps and a run disposition line"
```

---

### Task 7: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (workflow templates section)
- No code changes.

**Interfaces:** none — verification and documentation only.

- [ ] **Step 1: Run the full suite and typecheck**

```bash
npm test
npm run typecheck
```

Expected: all tests PASS, typecheck clean. Fix any fallout before proceeding (the repo has no test CI — the `review` check is an AI verdict — so this local run is the merge gate).

- [ ] **Step 2: Document the behavior in CLAUDE.md**

In `CLAUDE.md`, in the "Workflow templates" section, directly after the **Gap analysis** bullet, add:

```markdown
- **Unapproved runs → draft PR** — when the implement/review feedback loop exhausts its iterations (or a pass hits the hard `max_turns` cap) without reviewer approval, the pipeline still pushes the working tree and opens a **draft PR** whose body carries the reviewer's final feedback, per-pass turn/cost stats, and (on `max_turns`) a read-only post-mortem. The runner reports the run as a coded failure (`REVIEW_UNAPPROVED` or `MAX_TURNS_EXHAUSTED`, with the draft-PR URL) so the ticket is updated and notifications fire; a run-autopsy comment is posted to the ticket; the GHA job stays green with a `::warning::` annotation. If the repo plan rejects draft PRs (422), the PR is opened normally with the title prefix `[NEEDS REVIEW — unapproved]`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe unapproved-run draft-PR behavior and failure codes"
```

---

## Self-Review (completed)

- **Spec coverage:** A (draft PR, fallback, body, skips) → Task 3; B (telemetry, tool trace, max_turns stop, post-mortem) → Tasks 1-2; C (outcome derivation, failure codes, prUrl on failure, callback always, orchestrator rendering + job prUrl) → Tasks 4-5; D (console.warn → Task 2, `::warning::` → Task 4, skipped steps + disposition → Task 6); E (autopsy comment file) → Task 4. Error handling: draft 422 fallback (T3), post-mortem non-fatal (T2), autopsy write non-fatal (T4). Testing section → per-task tests. Rollout → four commits map to spec's four clusters plus orchestrator + polish.
- **Type consistency:** `terminationReason`/`passes`/`postMortem` names identical in feedback-loop outputs (T2), pipeline-loader wiring (T3), run-autonomous reads (T4), and `RunAutopsy`/`ReviewSummary` pass shapes match `PassStat` field-for-field. `failureCode` literals identical in T4 (producer) and T5 (consumer). `formatSummary` third parameter matches its T6 caller.
- **Placeholders:** test steps that depend on file-local scaffolding (run-autonomous, runner-callback) explicitly instruct reading the file's existing helpers first and state the exact assertions — intentional, since those harnesses are large and must be reused, not reinvented.
