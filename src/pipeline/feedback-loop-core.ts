import type { InvocationAttributionV1, RunTelemetry, Step } from "./types.js";
import type { ReferenceRepoResult } from "../reference-repos.js";
import { wrapWithPlanningGuard } from "../planning-context-assembly.js";
import { classifyThrown, type FailureRecord } from "./failure-classification.js";
import { computeBackoffMs, type RetryPolicy } from "./retry-backoff.js";
import { inferTestResults, sumUsage, toolTraceLines, type CycleSummaryInput, type CycleVerifyHook } from "./cycle-summary.js";

/**
 * Control flow of the implement/review loop, extracted from `feedbackLoopStep`
 * (AII-626). Every effect — model calls, git reads, the cycle-summary write,
 * reporting, sleeping, clocks, logging — arrives through `LoopEffects`, so this
 * module does no I/O of its own and a test-only Restate workflow can run the same
 * production code with journaled effects. The pipeline never depends on the
 * durable-execution runtime or its SDK; the dependency points the other way.
 */

const ACCEPTANCE_BAR_HEADER = "## ✅ AI Planning: Acceptance Bar";
const MAP_HEADER = "## 🗺 AI Planning: Implementation Map";

// All recognised planning-section headers. A section ends only when one of
// these appears, so internal subheadings (e.g. "## Files" inside the Map) do
// not split the section prematurely.
const PLANNING_HEADERS = [
  "## 🏗️ AI Planning: Architecture Analysis",
  "## 🧪 AI Planning: Test Plan",
  "## 🔗 AI Planning: Cross-Story Context",
  "## 🗺 AI Planning: Implementation Map",
  "## ✅ AI Planning: Acceptance Bar",
  "## ⚠️ AI Planning: Risks & Open Questions",
];

function extractSection(text: string, header: string): string | undefined {
  const startIdx = text.indexOf(header);
  if (startIdx === -1) return undefined;
  const afterStart = startIdx + header.length;
  let sectionEnd = text.length;
  for (const h of PLANNING_HEADERS) {
    if (h === header) continue;
    const idx = text.indexOf(h, afterStart);
    if (idx !== -1 && idx < sectionEnd) sectionEnd = idx;
  }
  // Strip planning_context wrapper tags that appear when this is the last section,
  // then strip the trailing "---" separator from the "\n\n---\n\n" join format.
  return text
    .slice(startIdx, sectionEnd)
    .replace(/<\s*\/?\s*planning_context\s*>/gi, "")
    .trim()
    .replace(/\n\n---\s*$/, "")
    .trim();
}

export function splitPlanningContext(planningContext: string): {
  acceptanceBar: string | undefined;
  mapSection: string | undefined;
} {
  return {
    acceptanceBar: extractSection(planningContext, ACCEPTANCE_BAR_HEADER),
    mapSection: extractSection(planningContext, MAP_HEADER),
  };
}

export type TerminationReason =
  | "approved"
  | "iterations_exhausted"
  | "review_error"
  | "max_turns"
  | "provider_unavailable"
  | "verify_failed";

export interface PassStat extends Record<string, unknown> {
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;   // RunTelemetry outcome or "unknown"
  costUsd: number | null;
  reviewTelemetry?: RunTelemetry;
  reviewCostUsd: number | null; // null when review never ran, or ran without telemetry, on this pass
  reviewApproved: boolean | null; // null when review never ran on this pass
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /** Spawn attempts the implement call made for this pass (>1 only under a retried transient failure). */
  attempts?: number;
  /** Spawn attempts the review call made for this pass, when review ran (>1 only under a retried transient failure). */
  reviewAttempts?: number;
  /** Failure code when the implement invocation failed yet the pass went on to review; the review verdict never clears it. */
  implementFailureCode?: string;
  /** Redacted one-line cause for `implementFailureCode` (the failure record's message). */
  implementFailureMessage?: string;
  /** Optional implement-invocation attribution (AII-946/954), carried from telemetry; absent on legacy executors. */
  attribution?: InvocationAttributionV1;
  implementFallbackFrom?: string;
  reviewFallbackFrom?: string;
  /** Exit code of the `verify` hook run after this pass; absent when the hook did not run. */
  verifyExitCode?: number;
  /** `false` when the verify hook ran with the workspace guard failed (snapshot or restore); absent otherwise. */
  verifyGuarded?: false;
}

export interface FeedbackLoopOutputs extends Record<string, unknown> {
  approved: boolean;
  iterations: number;
  finalFeedback: string;
  terminationReason: TerminationReason;
  passes: PassStat[];
  postMortem?: string;
  /** Set only for terminationReason "provider_unavailable" — the classified failure the
   *  runner callback reports through `postRunnerResult`/`formatFailureComment`. */
  failure?: FailureRecord;
  /** Sum of every superseded implement/review retry attempt's cost — never reflected in
   *  `passes`, which only carries the attempt that ultimately settled each stage. Mirrors
   *  report-card.ts's extraCostUsd `.retry` rows so the ticket-facing total (run-autonomous.ts)
   *  can agree with the report card (BAC-27201). */
  extraCostUsd: number | null;
  /** Superseded retry attempts that produced no reported cost, so `extraCostUsd` is a lower bound. */
  extraCostUnreported?: number;
}

function addExtraCost(a: number | null, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function buildImplementPrompt(
  issueTitle: string,
  issueDescription: string,
  reviewFeedback: string | undefined,
  reviewIssues: string[],
  issueIdentifier: string,
  implementationPrompt?: string,
  installFailed?: boolean,
  installMethod?: string,
  installError?: string,
  verifyFailure?: string,
  verifyHookConfigured?: boolean,
): string {
  const basePrompt =
    implementationPrompt && implementationPrompt.trim()
      ? implementationPrompt
      : `Implement the following issue.\n\nTitle: ${issueTitle}\n\nDescription:\n${issueDescription}`;

  let prompt = basePrompt;

  // Appended on every iteration, including review-feedback ones — a
  // review-feedback pass that doesn't see this reads the test failures as
  // its own defects.
  if (installFailed) {
    prompt += `\n\n## Dependency install failed\n\n\`${installMethod ?? "install"}\` failed in this workspace, so \`node_modules\` is missing or incomplete:\n\n\`\`\`\n${installError ?? ""}\n\`\`\`\n\nBuild, test, lint, and typecheck commands will not work until this is resolved.\nDo not treat their failure as a defect in the code you are asked to change. If the\ndependency problem is within the scope of this issue, fixing it is in scope. The\npipeline runs the install again after you finish. Otherwise work from source and\nsay so in your summary.`;
  }

  if (verifyHookConfigured) {
    prompt += `\n\n## Verify hook\n\nAfter each pass the pipeline runs this repo's verify hook (build and checks) and sends you its output if it fails. You do not need to repeat full builds in a loop; you can still run a build when you want to.`;
  }

  if (verifyFailure) {
    prompt += `\n\n## Verify hook failed\n\n${verifyFailure}\n\nFix the cause of this failure. The pipeline runs the hook again after your pass.`;
  }

  if (reviewFeedback || reviewIssues.length > 0) {
    const issueBlock =
      reviewIssues.length > 0
        ? `\n\nReviewer issues:\n${reviewIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`
        : "";
    prompt += `\n\n## Reviewer Feedback\n\nYou previously attempted to implement ${issueIdentifier}: ${issueTitle}.${issueBlock}\n\nReviewer feedback:\n${reviewFeedback ?? "(none)"}\n\nPlease address every listed issue and use the feedback for context.`;
  }

  return prompt;
}

const IMPLEMENT_CONTINUATION_NOTE =
  "A previous attempt was interrupted by a provider error. The working tree contains its partial changes. Continue from the current state; do not revert it.";

/** Structural view of `implementStep`'s outputs — only what the loop reads. */
export interface LoopImplementResult extends Record<string, unknown> {
  telemetry?: RunTelemetry;
  attempts?: number;
}

/** Structural view of `reviewStep`'s outputs — only what the loop reads. */
export interface LoopReviewResult extends Record<string, unknown> {
  approved: boolean;
  issues: string[];
  feedback: string;
  attempts?: number;
  telemetry?: RunTelemetry;
}

export interface LoopEffects {
  implement(args: { prompt: string; planningContext: string | undefined; iteration: number }): Promise<LoopImplementResult>;
  review(args: { diff: string; iteration: number; acceptanceBar: string | undefined; reviewRubric: string | undefined }): Promise<LoopReviewResult>;
  /** Non-fatal: resolves to null when the post-mortem could not be produced. */
  postMortem(args: { diff: string; telemetry: RunTelemetry; iteration: number }): Promise<string | null>;
  getDiff(): string;
  isRunDirty(): boolean;
  writeCycleSummary(input: CycleSummaryInput): void;
  report(step: Step): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** ISO timestamp. */
  now(): string;
  warn(message: string): void;
  /**
   * Runs the repo's `verify` hook with the workspace guarded (snapshot before, restore after),
   * so the hook cannot change what ships. A missing script or spawn failure resolves to a
   * non-zero `exitCode` rather than throwing. `output` is the redacted tail of the hook's output,
   * already safe to embed in a fenced block. Required when `params.verifyEnabled` is true.
   */
  runVerifyHook?(): Promise<{ exitCode: number; output: string; guarded: boolean; durationMs: number }>;
}

export interface FeedbackLoopCoreParams {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  issueIdentifier: string;
  implementationPrompt?: string;
  planningContext?: string;
  referenceRepoResults?: ReferenceRepoResult[];
  reviewRubric?: string;
  installFailed: boolean;
  installMethod?: string;
  installError?: string;
  maxIterations: number;
  maxTurns: number;
  implementModel: string;
  reviewModel: string;
  retryPolicy: RetryPolicy;
  /** HEAD at the start of the run; recorded as each cycle summary's input commit. */
  runStartHead: string;
  parentStepId: string;
  /** True when a `verify` hook is configured and the first install succeeded: the hook runs after
   *  every implement pass that ends normally, before that pass's review (`effects.runVerifyHook`). */
  verifyEnabled?: boolean;
}

export async function runFeedbackLoop(
  params: FeedbackLoopCoreParams,
  effects: LoopEffects,
): Promise<FeedbackLoopOutputs> {
  let iteration = 0;
  let approved = false;
  let feedback = "";
  let reviewIssues: string[] = [];
  let terminationReason: TerminationReason = "iterations_exhausted";
  const passes: PassStat[] = [];
  const fallbackOrigins: Partial<Record<"implementation" | "review", string>> = {};
  let postMortem: string | undefined;
  let failureForOutputs: FailureRecord | undefined;
  // Sum of every superseded implement/review retry attempt's cost — real spend that a
  // pass's own costUsd/reviewCostUsd never carries, since those reflect only the attempt
  // that ultimately settled the stage. Mirrors report-card.ts's extraCostUsd `.retry` rows
  // so the ticket-facing total can agree with the report card (BAC-27201).
  let extraCostUsd: number | null = null;
  let extraCostUnreported = 0;
  // Verify-hook failure from the previous pass, shown to the next implement pass; cleared by a passing hook.
  let verifyFailure: string | undefined;
  const verifyEnabled = params.verifyEnabled === true && effects.runVerifyHook !== undefined;

  const rawPlanningContext = params.planningContext;
  const { acceptanceBar, mapSection } = splitPlanningContext(rawPlanningContext ?? "");
  const isNewFormatContext = acceptanceBar !== undefined || mapSection !== undefined;

  while (iteration < params.maxIterations && !approved) {
    iteration++;

    // On retries with new-format context, send only the map section — but
    // re-wrap it with the untrusted-data guard so the security preamble is
    // never dropped. Fall back to the full rawPlanningContext when mapSection
    // is absent (partial planning output) rather than sending undefined.
    const implementPlanningContext =
      isNewFormatContext && iteration > 1
        ? mapSection !== undefined
          ? wrapWithPlanningGuard(mapSection)
          : rawPlanningContext
        : rawPlanningContext;

    const implementPrompt = buildImplementPrompt(
      params.issueTitle,
      params.issueDescription,
      feedback || undefined,
      reviewIssues,
      params.issueIdentifier,
      params.implementationPrompt,
      params.installFailed === true,
      params.installMethod,
      params.installError,
      verifyFailure,
      verifyEnabled,
    );

    // --- implement sub-step (stage-level retry on a transient failure, BAC-27134) ---
    let currentImplementPrompt = implementPrompt;
    let implementStageAttempt = 0;
    let implementAttemptsTotal = 0;
    let implementOutputs: LoopImplementResult | undefined;
    let implementProviderUnavailable: FailureRecord | undefined;
    let implementProviderUnavailableTelemetry: RunTelemetry | undefined;

    for (;;) {
      implementStageAttempt++;
      const implementSubStep: Step = {
        id: `implement.${iteration}`,
        type: "implement",
        status: "running",
        started_at: effects.now(),
        ended_at: null,
        parent_step_id: params.parentStepId,
        inputs: {
          workspaceDir: params.workspaceDir,
          prompt: currentImplementPrompt,
          model: params.implementModel,
          maxTurns: params.maxTurns,
          planningContext: implementPlanningContext,
          referenceRepoResults: params.referenceRepoResults,
        },
        outputs: {},
        logs_url: null,
      };
      await effects.report(implementSubStep);

      try {
        const outputs = await effects.implement({
            prompt: currentImplementPrompt,
            planningContext: implementPlanningContext,
            iteration,
          });
        const invocationFailure = outputs.invocationFailure as FailureRecord | undefined;
        // Exit-zero fatal results normally retain partial work for review. A capacity
        // switch must instead reach the same retry rail as a thrown invocation failure.
        if (invocationFailure?.accountFallback || invocationFailure?.code === "ACCOUNT_USAGE_LIMIT" || invocationFailure?.modelFallback || (invocationFailure?.code === "PROVIDER_OVERLOADED" && fallbackOrigins.implementation)) {
          throw Object.assign(new Error(invocationFailure.message), { failure: invocationFailure, telemetry: outputs.telemetry });
        }
        implementSubStep.status = "passed";
        implementSubStep.ended_at = effects.now();
        implementSubStep.outputs = outputs;
        await effects.report(implementSubStep);
        implementAttemptsTotal += outputs.attempts ?? 1;
        implementOutputs = outputs;
        break;
      } catch (err) {
        implementSubStep.status = "failed";
        implementSubStep.ended_at = effects.now();
        const implementStage = `feedback-loop/implement-${iteration}`;
        // Re-stamp `stage`: classifyThrown() passes an already-attached record
        // (from the executor's classifyLlmResult, surfaced onto the thrown error by
        // implementStep) through unchanged, which would otherwise leave the
        // iteration-qualified stage never applied.
        const implementFailure = { ...classifyThrown(err, { stage: implementStage, attempt: 1 }), stage: implementStage };
        // implement.ts (and the executor, for a spawn-level rejection) stamps
        // `err.telemetry` when every attempt fails — surface it on the failed
        // sub-step report too, or the tokens/cost that attempt burned are lost
        // from the run's evidence entirely rather than merely absent from PassStat.
        const implementErrTelemetry =
          typeof err === "object" && err !== null ? (err as { telemetry?: RunTelemetry }).telemetry : undefined;
        const isTransient = implementFailure.category === "transient";
        const fallback = implementFailure.modelFallback;
        const fallbackRetry = fallback?.stage === "implementation" && !fallbackOrigins.implementation;
        if (fallbackRetry) fallbackOrigins.implementation = fallback.from;
        const willRetryImplement = implementFailure.accountFallback?.stage === "implementation" || fallbackRetry || (isTransient && implementStageAttempt <= params.retryPolicy.stageRetries);
        // A retried attempt's failure must not overwrite the canonical `implement.{iteration}`
        // row — that id is reserved for the final attempt (BAC-27134's "keep every attempt's
        // evidence"), so a retried attempt's failure record and telemetry are preserved under
        // their own id instead of being clobbered by the next attempt's "running" report.
        if (willRetryImplement) {
          implementSubStep.id = `implement.${iteration}.retry${implementStageAttempt}`;
          extraCostUsd = addExtraCost(extraCostUsd, implementErrTelemetry?.costUsd);
          if (implementErrTelemetry?.costUsd == null) extraCostUnreported++;
        }
        implementSubStep.outputs = {
          error: String(err),
          failure: implementFailure,
          ...(implementErrTelemetry ? { telemetry: implementErrTelemetry } : {}),
        };
        await effects.report(implementSubStep);
        if (typeof err === "object" && err !== null) {
          try {
            (err as Record<string, unknown>).failure = implementFailure;
          } catch {
            // err may be frozen/non-extensible — losing the attached record here
            // must not turn this catch path itself into a thrown TypeError.
          }
        }
        implementAttemptsTotal += implementFailure.attempt;

        if (willRetryImplement) {
          const dirtyForRetry = effects.isRunDirty();
          await effects.sleep(computeBackoffMs(implementStageAttempt, params.retryPolicy));
          currentImplementPrompt = dirtyForRetry
            ? `${implementPrompt}\n\n${IMPLEMENT_CONTINUATION_NOTE}`
            : implementPrompt;
          continue;
        }

        if (isTransient) {
          const providerUnavailableFailure: FailureRecord = {
            ...implementFailure,
            stage: "implement",
            code: "PROVIDER_UNAVAILABLE",
            // Exhausted the stage-retry budget: this record is terminal, matching the
            // convention push.ts's GIT_PUSH_RETRIES_EXHAUSTED states — an orchestrator
            // rail keying off `retryable` must not start a run again that already spent
            // its whole stage-retry budget.
            retryable: false,
          };
          const dirtyFinal = effects.isRunDirty();
          if (dirtyFinal) {
            // Partial work survives: stop the loop and let the pipeline push it as a
            // draft PR rather than throwing it away.
            implementProviderUnavailable = providerUnavailableFailure;
            implementProviderUnavailableTelemetry = implementErrTelemetry;
            break;
          }
          // Clean tree: nothing to preserve — fail the run with PROVIDER_UNAVAILABLE.
          if (typeof err === "object" && err !== null) {
            try {
              (err as Record<string, unknown>).failure = providerUnavailableFailure;
            } catch {
              // err may be frozen/non-extensible
            }
          }
          throw err;
        }

        throw err;
      }
    }

    if (implementProviderUnavailable) {
      terminationReason = "provider_unavailable";
      feedback = `Tried ${implementStageAttempt} time(s); partial changes were kept. ${implementProviderUnavailable.message}`;
      failureForOutputs = implementProviderUnavailable;
      passes.push({
        implementFallbackFrom: fallbackOrigins.implementation,
        iteration,
        implementTurns: implementProviderUnavailableTelemetry?.numTurns ?? null,
        implementOutcome: "error",
        costUsd: implementProviderUnavailableTelemetry?.costUsd ?? null,
        reviewCostUsd: null,
        reviewApproved: null,
        tokensIn: implementProviderUnavailableTelemetry?.tokensIn ?? null,
        tokensOut: implementProviderUnavailableTelemetry?.tokensOut ?? null,
        cacheReadTokens: implementProviderUnavailableTelemetry?.cacheReadTokens ?? null,
        cacheCreationTokens: implementProviderUnavailableTelemetry?.cacheCreationTokens ?? null,
        attempts: implementAttemptsTotal,
        ...(implementProviderUnavailableTelemetry?.attribution ? { attribution: implementProviderUnavailableTelemetry.attribution } : {}),
      });
      effects.writeCycleSummary({
        id: `feedback-loop.${iteration}`,
        stage: "feedback-loop",
        cycle: iteration,
        inputCommit: params.runStartHead,
        outputCommit: null,
        outputCommitStatus: "pending_push",
        dispositions: [],
        tests: inferTestResults(toolTraceLines(implementProviderUnavailableTelemetry), undefined, implementProviderUnavailableTelemetry?.executedCommands),
        verdict: { approved: null, reason: "provider_unavailable", summary: implementProviderUnavailable.message },
        usage: sumUsage(implementProviderUnavailableTelemetry),
      });
      break;
    }

    if (!implementOutputs) {
      throw new Error("[feedback-loop] implement stage ended without outputs or a provider-unavailable failure");
    }

    const implementTelemetry = implementOutputs.telemetry as RunTelemetry | undefined;
    const implementInvocationFailure = implementOutputs.invocationFailure as FailureRecord | undefined;
    const pass: PassStat = {
      iteration,
      implementTurns: implementTelemetry?.numTurns ?? null,
      implementOutcome: implementTelemetry?.outcome ?? "unknown",
      costUsd: implementTelemetry?.costUsd ?? null,
      reviewCostUsd: null,
      reviewApproved: null,
      tokensIn: implementTelemetry?.tokensIn ?? null,
      tokensOut: implementTelemetry?.tokensOut ?? null,
      cacheReadTokens: implementTelemetry?.cacheReadTokens ?? null,
      cacheCreationTokens: implementTelemetry?.cacheCreationTokens ?? null,
      attempts: implementAttemptsTotal,
      ...(implementInvocationFailure
        ? { implementFailureCode: implementInvocationFailure.code, implementFailureMessage: implementInvocationFailure.message }
        : {}),
      ...(implementTelemetry?.attribution ? { attribution: implementTelemetry.attribution } : {}),
    };
    pass.implementFallbackFrom = fallbackOrigins.implementation;
    passes.push(pass);

    const diff = effects.getDiff();

    // Hard max_turns: the pass ran out of budget mid-work. Reviewing or
    // re-implementing an over-scoped task just burns more passes — stop,
    // post-mortem where the turns went, and let the pipeline open a draft PR.
    //
    // The CLI's error_max_turns subtype (outcome === "max_turns") is the ONLY
    // authoritative signal. Do NOT also compare telemetry.numTurns against the
    // configured cap: result.num_turns counts conversation MESSAGES, not the
    // agent turns --max-turns bounds — this repo's own telemetry fixture pins a
    // real production run reporting subtype "success" at num_turns 104 under
    // the default 50-turn cap (7b74bf6). A numTurns comparison falsely fails
    // successful passes: review skipped, draft PR, MAX_TURNS_EXHAUSTED.
    if (implementTelemetry && implementTelemetry.outcome === "max_turns") {
      terminationReason = "max_turns";
      feedback = `Implementation hit the ${params.maxTurns}-turn cap before completing (${implementTelemetry.numTurns ?? "?"} turns used).`;
      postMortem =
        (await effects.postMortem({
          diff,
          telemetry: implementTelemetry,
          iteration,
        })) ?? undefined;
      effects.writeCycleSummary({
        id: `feedback-loop.${iteration}`,
        stage: "feedback-loop",
        cycle: iteration,
        inputCommit: params.runStartHead,
        outputCommit: null,
        outputCommitStatus: "pending_push",
        dispositions: [],
        tests: inferTestResults(toolTraceLines(implementTelemetry), undefined, implementTelemetry?.executedCommands),
        verdict: { approved: null, reason: "max_turns", summary: feedback },
        usage: sumUsage(implementTelemetry),
      });
      break;
    }

    // --- verify hook: runs after every pass that ended normally, before that pass's review ---
    let verifyHook: CycleVerifyHook | undefined;
    verifyFailure = undefined;
    if (verifyEnabled && effects.runVerifyHook) {
      const hookResult = await effects.runVerifyHook();
      const exitCode = hookResult.exitCode;
      verifyHook = { ran: true, exitCode, durationMs: hookResult.durationMs, ...(hookResult.guarded ? {} : { guarded: false }) };
      if (!hookResult.guarded) pass.verifyGuarded = false;
      pass.verifyExitCode = exitCode;
      if (exitCode !== 0) {
        verifyFailure = `The verify hook failed with exit code ${exitCode}. Last part of its output:\n\n\`\`\`\n${hookResult.output}\n\`\`\``;
        terminationReason = "verify_failed";
        effects.writeCycleSummary({
          id: `feedback-loop.${iteration}`,
          stage: "feedback-loop",
          cycle: iteration,
          inputCommit: params.runStartHead,
          outputCommit: null,
          outputCommitStatus: "pending_push",
          dispositions: [],
          tests: inferTestResults(toolTraceLines(implementTelemetry), undefined, implementTelemetry?.executedCommands),
          verdict: { approved: null, reason: "verify_failed", summary: verifyFailure },
          usage: sumUsage(implementTelemetry),
          verifyHook,
        });
        continue;
      }
    }

    // --- review sub-step (stage-level retry on a transient failure, BAC-27134) ---
    const reviewRubric = params.reviewRubric;
    let reviewStageAttempt = 0;
    let reviewAttemptsTotal = 0;
    let reviewStageFailed = false;

    for (;;) {
      reviewStageAttempt++;
      const reviewSubStep: Step = {
        id: `review.${iteration}`,
        type: "review",
        status: "running",
        started_at: effects.now(),
        ended_at: null,
        parent_step_id: params.parentStepId,
        inputs: {
          model: params.reviewModel,
          diff,
          iteration,
          issueTitle: params.issueTitle,
          issueDescription: params.issueDescription,
          acceptanceBar,
          ...(reviewRubric ? { reviewRubric } : {}),
          installFailed: params.installFailed === true,
        },
        outputs: {},
        logs_url: null,
      };
      await effects.report(reviewSubStep);

      try {
        const reviewOutputs = await effects.review({
            diff,
            iteration,
            acceptanceBar,
            reviewRubric,
          });
        reviewSubStep.status = "passed";
        reviewSubStep.ended_at = effects.now();
        reviewSubStep.outputs = reviewOutputs;
        await effects.report(reviewSubStep);

        reviewAttemptsTotal += reviewOutputs.attempts ?? 1;
        approved = reviewOutputs.approved;
        feedback = reviewOutputs.feedback;
        reviewIssues = [...reviewOutputs.issues];
        pass.reviewApproved = reviewOutputs.approved;
        pass.reviewAttempts = reviewAttemptsTotal;
        pass.reviewFallbackFrom = fallbackOrigins.review;
        pass.reviewTelemetry = reviewOutputs.telemetry;
        pass.reviewCostUsd = reviewOutputs.telemetry?.costUsd ?? null;
        // Reset, not just set on approval: an earlier pass may have ended verify_failed.
        terminationReason = approved ? "approved" : "iterations_exhausted";
        effects.writeCycleSummary({
          id: `feedback-loop.${iteration}`,
          stage: "feedback-loop",
          cycle: iteration,
          inputCommit: params.runStartHead,
          outputCommit: null,
          outputCommitStatus: "pending_push",
          dispositions: [],
          tests: inferTestResults([...toolTraceLines(implementTelemetry), ...toolTraceLines(reviewOutputs.telemetry)], undefined, [...(implementTelemetry?.executedCommands ?? []), ...(reviewOutputs.telemetry?.executedCommands ?? [])]),
          verdict: {
            approved: reviewOutputs.approved,
            reason: reviewOutputs.approved ? "approved" : "changes_requested",
            // An approving review never clears the implement invocation's own failure.
            summary: implementInvocationFailure
              ? `Implement invocation failed (${implementInvocationFailure.code}): ${implementInvocationFailure.message}\n\n${reviewOutputs.feedback}`
              : reviewOutputs.feedback,
          },
          usage: sumUsage(implementTelemetry, reviewOutputs.telemetry),
          ...(verifyHook ? { verifyHook } : {}),
        });
        break;
      } catch (err) {
        // A review failure (e.g. "Prompt is too long", a transient API error)
        // is NOT actionable feedback and must not discard a successful
        // implementation. Record the failure, stop the loop, and let the
        // pipeline push the working tree — retrying implementation would only
        // burn another pass producing the same un-reviewable diff.
        reviewSubStep.status = "failed";
        reviewSubStep.ended_at = effects.now();
        const reviewStage = `feedback-loop/review-${iteration}`;
        // Re-stamp `stage`: classifyThrown() passes an already-attached record
        // (from the executor's classifyLlmResult, surfaced onto the thrown error by
        // reviewStep) through unchanged, which would otherwise leave the
        // iteration-qualified stage never applied.
        const reviewFailure = { ...classifyThrown(err, { stage: reviewStage, attempt: 1 }), stage: reviewStage };
        const reviewErrTelemetry =
          typeof err === "object" && err !== null ? (err as { telemetry?: RunTelemetry }).telemetry : undefined;
        const isTransient = reviewFailure.category === "transient";
        const fallback = reviewFailure.modelFallback;
        const fallbackRetry = fallback?.stage === "review" && !fallbackOrigins.review;
        if (fallbackRetry) fallbackOrigins.review = fallback.from;
        const willRetryReview = reviewFailure.accountFallback?.stage === "review" || fallbackRetry || (isTransient && reviewStageAttempt <= params.retryPolicy.stageRetries);
        // A retried attempt's failure must not overwrite the canonical `review.{iteration}`
        // row — see the matching implement-stage comment above (BAC-27134).
        if (willRetryReview) {
          reviewSubStep.id = `review.${iteration}.retry${reviewStageAttempt}`;
          extraCostUsd = addExtraCost(extraCostUsd, reviewErrTelemetry?.costUsd);
          if (reviewErrTelemetry?.costUsd == null) extraCostUnreported++;
        }
        reviewSubStep.outputs = {
          error: String(err),
          failure: reviewFailure,
          ...(reviewErrTelemetry ? { telemetry: reviewErrTelemetry } : {}),
        };
        await effects.report(reviewSubStep);
        reviewAttemptsTotal += reviewFailure.attempt;

        if (willRetryReview) {
          await effects.sleep(computeBackoffMs(reviewStageAttempt, params.retryPolicy));
          continue;
        }

        approved = false;
        pass.reviewFallbackFrom = fallbackOrigins.review;
        pass.reviewTelemetry = reviewErrTelemetry;
        pass.reviewCostUsd = reviewErrTelemetry?.costUsd ?? null;
        pass.reviewAttempts = reviewAttemptsTotal;
        reviewStageFailed = true;

        if (isTransient) {
          effects.warn(
            `[feedback-loop] Review step remained transiently unavailable after ${reviewStageAttempt} attempt(s) on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
          );
          terminationReason = "provider_unavailable";
          // Terminal: the stage-retry budget is spent (matches push.ts's
          // GIT_PUSH_RETRIES_EXHAUSTED convention) — never retryable.
          failureForOutputs = { ...reviewFailure, stage: "review", code: "PROVIDER_UNAVAILABLE", retryable: false };
          feedback = `Tried ${reviewStageAttempt} time(s). ${reviewFailure.message}`;
        } else {
          effects.warn(
            `[feedback-loop] Review step failed on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
          );
          // Preserve terminal usage-limit and checkout failures for the run's notice.
          failureForOutputs = reviewFailure;
          feedback = `Review step failed and was skipped: ${String(err)}`;
          terminationReason = "review_error";
        }
        effects.writeCycleSummary({
          id: `feedback-loop.${iteration}`,
          stage: "feedback-loop",
          cycle: iteration,
          inputCommit: params.runStartHead,
          outputCommit: null,
          outputCommitStatus: "pending_push",
          dispositions: [],
          tests: inferTestResults(toolTraceLines(implementTelemetry), undefined, implementTelemetry?.executedCommands),
          verdict: { approved: null, reason: terminationReason, summary: feedback },
          usage: sumUsage(implementTelemetry, reviewErrTelemetry),
          ...(verifyHook ? { verifyHook } : {}),
        });
        break;
      }
    }

    if (reviewStageFailed) break;
  }

  // A run that ends on a failing hook reports the hook's output, not the last review's feedback.
  const finalFeedback = terminationReason === "verify_failed" && verifyFailure ? verifyFailure : feedback;

  if (!approved) {
    effects.warn(
      `[feedback-loop] exited without approval (${terminationReason}) after ${iteration}/${params.maxIterations} iteration(s). Final feedback: ${finalFeedback || "(none)"}`,
    );
  }

  return {
    approved,
    iterations: iteration,
    finalFeedback,
    terminationReason,
    passes,
    extraCostUsd,
    extraCostUnreported,
    ...(postMortem ? { postMortem } : {}),
    ...(failureForOutputs ? { failure: failureForOutputs } : {}),
  };
}
