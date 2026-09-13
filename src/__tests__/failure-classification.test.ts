import { describe, expect, it, afterEach, vi } from "vitest";
import {
  classifyLlmResult,
  classifyGitFailure,
  classifyThrown,
  classifySpawnError,
  redactEvidence,
  tailBytes,
  isFailureRecord,
  projectFailureRecord,
  EVIDENCE_TAIL_BYTES,
  NO_DETAIL_MESSAGE,
  type FailureRecord,
} from "../pipeline/failure-classification.js";
import type { LLMResult } from "../pipeline/types.js";

function llmResult(overrides: Partial<LLMResult> = {}): LLMResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

const CTX = { stage: "implement", attempt: 1, expectsStructuredOutput: false };

describe("classifyLlmResult", () => {
  afterEach(() => vi.unstubAllEnvs());

  // Fixture approximates the Claude CLI's stderr shape for a 529 overload, based on the
  // Anthropic API's documented error envelope. Whether the CLI performed internal retries
  // before surfacing this to the pipeline is not established by this fixture and is not
  // assumed either way — the notes on BAC-27111 are explicit that this must stay open.
  const OVERLOAD_STDERR =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

  const AUTH_STDERR =
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

  it("classifies a real 529 overloaded_error stderr as transient/PROVIDER_OVERLOADED", () => {
    const record = classifyLlmResult(
      llmResult({ stderr: OVERLOAD_STDERR, exitCode: 1 }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_OVERLOADED");
    expect(record.retryable).toBe(true);
  });

  it("classifies a real 401 stderr as auth/PROVIDER_AUTH", () => {
    const record = classifyLlmResult(llmResult({ stderr: AUTH_STDERR, exitCode: 1 }), CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("PROVIDER_AUTH");
    expect(record.retryable).toBe(false);
  });

  it("classifies a 429 rate limit as transient/PROVIDER_RATE_LIMITED", () => {
    const record = classifyLlmResult(
      llmResult({ stderr: "HTTP 429 rate_limit_error: too many requests", exitCode: 1 }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_RATE_LIMITED");
  });

  it("classifies a transport error (ECONNRESET) as transient/PROVIDER_TRANSPORT", () => {
    const record = classifyLlmResult(llmResult({ stderr: "Error: ECONNRESET", exitCode: 1 }), CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_TRANSPORT");
  });

  it("classifies an unknown model id as config/PROVIDER_CONFIG", () => {
    const record = classifyLlmResult(
      llmResult({ stderr: "invalid_request_error: unknown model claude-bogus", exitCode: 1 }),
      CTX,
    );
    expect(record.category).toBe("config");
    expect(record.code).toBe("PROVIDER_CONFIG");
  });

  it("classifies missing structured output as invalid_output/LLM_NO_STRUCTURED_OUTPUT when the call site expects it", () => {
    const record = classifyLlmResult(
      llmResult({ exitCode: 0, structuredOutput: undefined, terminalStatus: { subtype: "success", isError: false } }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_NO_STRUCTURED_OUTPUT");
    expect(record.retryable).toBe(false);
    expect(record.evidence.llmSubtype).toBe("success");
    expect(record.evidence.llmIsError).toBe(false);
  });

  it("does NOT classify missing structured output as invalid_output when the call site doesn't expect it (implement)", () => {
    // implement never requests structured output; without expectsStructuredOutput gating,
    // a plain implement crash (exit 1, no recognised provider signature) would be
    // misclassified as invalid_output/LLM_NO_STRUCTURED_OUTPUT instead of crash.
    const record = classifyLlmResult(
      llmResult({
        exitCode: 1,
        stderr: "boom, nothing recognisable here",
        structuredOutput: undefined,
      }),
      CTX,
    );
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
  });

  it("classifies a review terminal error (exit 0, terminalStatus.isError) as invalid_output/LLM_TERMINAL_ERROR", () => {
    // structuredOutput is left undefined — both derive from the same `result` event,
    // and the CLI does not emit a structured_output alongside an errored terminal
    // status, so a fixture combining the two isn't an input the executor can produce.
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        terminalStatus: { subtype: "error_during_execution", isError: true },
      }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_TERMINAL_ERROR");
  });

  it("does not classify prose mentioning an HTTP status code without a protocol marker as transient (stdout)", () => {
    // Old marker (bare "HTTP") would have flagged this line and let PROVIDER_TRANSPORT's
    // \b503\b fire on it; the marker now requires an actual status-line shape (HTTP/\d).
    const record = classifyLlmResult(
      llmResult({ exitCode: 1, stdout: "added an HTTP 503 handler for the outage page", stderr: "" }),
      CTX,
    );
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
  });

  it("still matches a genuine HTTP/1.1 status line in stdout as transient", () => {
    const record = classifyLlmResult(
      llmResult({ exitCode: 1, stdout: "< HTTP/1.1 503 Service Unavailable", stderr: "" }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_TRANSPORT");
  });

  it("classifies a missing terminal event as invalid_output/LLM_NO_TERMINAL_EVENT when the call site expects structured output", () => {
    // Realistic input: terminalStatus and structuredOutput both derive from the
    // same `result` event, so a genuinely absent terminal event means both are
    // undefined — this must classify as the missing-event case, not be shadowed
    // by (or shadow) the missing-structured-output check.
    const record = classifyLlmResult(
      llmResult({ exitCode: 0, structuredOutput: undefined }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_NO_TERMINAL_EVENT");
  });

  it("does not apply LLM_NO_TERMINAL_EVENT when the call site doesn't expect structured output (implement)", () => {
    const record = classifyLlmResult(llmResult({ exitCode: 0, structuredOutput: undefined }), CTX);
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
  });

  it("classifies a non-success terminal subtype as invalid_output/LLM_TERMINAL_ERROR even when isError is false", () => {
    // structuredOutput left undefined for the same reason as the isError case above.
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        terminalStatus: { subtype: "error_max_turns", isError: false },
      }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_TERMINAL_ERROR");
  });

  it("does not misclassify model prose mentioning a status code as a transport failure (stdout, empty stderr)", () => {
    // LLMResult.stdout is the model's final text, not process output. "the handler
    // returns 503" is the model describing application behavior, not the transport
    // itself failing — it must not trip PROVIDER_TRANSPORT's \b503\b signature.
    const record = classifyLlmResult(
      llmResult({
        exitCode: 1,
        stdout: "the handler returns 503 when upstream is down",
        stderr: "",
      }),
      CTX,
    );
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
  });

  it("still matches a provider signature carried in stdout when the line also has a transport marker", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 1,
        stdout: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        stderr: "",
      }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_OVERLOADED");
  });

  it("matches stderr signatures wholesale even without a transport marker on every line", () => {
    const record = classifyLlmResult(llmResult({ stderr: "socket hang up", exitCode: 1 }), CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_TRANSPORT");
  });

  it("concatenates stderr with marker-filtered stdout instead of only matching stderr, so an unrelated stderr line doesn't hide a real signature in stdout", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 1,
        stderr: "(node:1234) ExperimentalWarning: some unrelated warning",
        stdout: 'noise line\nAPI Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_OVERLOADED");
  });

  it("requires a 3-digit code directly after 'status code' in the stdout transport marker, so loosely mentioning both doesn't trip a transient match", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 1,
        stdout: "we return a friendly status code page during outages; historically 503 was common",
        stderr: "",
      }),
      CTX,
    );
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
  });

  it("still matches 'status code 503' as a transport marker in stdout", () => {
    const record = classifyLlmResult(
      llmResult({ exitCode: 1, stdout: "responded with status code 503 Service Unavailable", stderr: "" }),
      CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_TRANSPORT");
  });

  it("matches 'status code: 503' and 'status code=503' as transport markers in stdout", () => {
    for (const stdout of ["responded with status code: 503", "responded with status code=503"]) {
      const record = classifyLlmResult(llmResult({ exitCode: 1, stdout, stderr: "" }), CTX);
      expect(record.category).toBe("transient");
      expect(record.code).toBe("PROVIDER_TRANSPORT");
    }
  });

  it("classifies a signalled attempt (result.signal set) as cancelled/PROCESS_SIGNALLED ahead of any text signature", () => {
    const record = classifyLlmResult(
      llmResult({ exitCode: 1, signal: "SIGTERM", stderr: "API Error: 529 overloaded_error" }),
      CTX,
    );
    expect(record.category).toBe("cancelled");
    expect(record.code).toBe("PROCESS_SIGNALLED");
    expect(record.signal).toBe("SIGTERM");
    expect(record.retryable).toBe(false);
  });

  it("carries telemetry.outcome into evidence.llmOutcome so a subtype=success/outcome=max_turns mismatch is explainable from the record", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        structuredOutput: undefined,
        terminalStatus: { subtype: "success", isError: false },
        telemetry: {
          outcome: "max_turns",
          numTurns: 50,
          durationMs: null,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
        },
      }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.evidence.llmOutcome).toBe("max_turns");
    expect(record.evidence.llmSubtype).toBe("success");
  });

  it("does not let a dropped reviewer verdict's mention of a transport error retry-classify a real structural failure (exit 0, missing structured output)", () => {
    // PROVIDER_SIGNATURES must never be consulted when exitCode === 0: the model's own
    // final text is part of the match input, so a reviewer verdict that got dropped
    // mid-stream (no structured_output) but happened to discuss "API Error 503" in its
    // prose must classify as the structural failure it is, not as a retryable transport
    // error just because the words appear in stdout. A terminal event IS present here
    // (realistic: the result event arrived but lacked structured_output) — that is what
    // distinguishes this from the "no terminal event at all" case above.
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        structuredOutput: undefined,
        terminalStatus: { subtype: "success", isError: false },
        stderr: "unrelated non-empty stderr text",
        stdout: "API Error 503 was mentioned once while summarizing the incident",
      }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_NO_STRUCTURED_OUTPUT");
  });

  it("classifies a subtype=success/outcome mismatch (e.g. max_turns) as invalid_output/LLM_OUTCOME_MISMATCH when structured output is otherwise present", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        structuredOutput: { ok: true },
        terminalStatus: { subtype: "success", isError: false },
        telemetry: {
          outcome: "max_turns",
          numTurns: 50,
          durationMs: null,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
        },
      }),
      { ...CTX, stage: "review", expectsStructuredOutput: true },
    );
    expect(record.category).toBe("invalid_output");
    expect(record.code).toBe("LLM_OUTCOME_MISMATCH");
  });

  it("does not apply LLM_OUTCOME_MISMATCH when the call site doesn't expect structured output (implement)", () => {
    const record = classifyLlmResult(
      llmResult({
        exitCode: 0,
        structuredOutput: { ok: true },
        terminalStatus: { subtype: "success", isError: false },
        telemetry: { outcome: "error", numTurns: 1, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null },
      }),
      CTX,
    );
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
  });

  it("classifies a non-zero exit with no recognised signature as crash/PROCESS_EXIT_NONZERO", () => {
    const record = classifyLlmResult(
      llmResult({ stderr: "boom, nothing recognisable here", exitCode: 1, structuredOutput: { ok: true } }),
      CTX,
    );
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
  });

  it("returns unknown/UNKNOWN with retryable false and populated evidence tails when nothing matches", () => {
    const record = classifyLlmResult(
      llmResult({
        stdout: "some ordinary stdout output",
        stderr: "some ordinary stderr output",
        exitCode: 0,
        structuredOutput: { ok: true },
      }),
      CTX,
    );
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
    expect(record.retryable).toBe(false);
    expect(record.evidence.stdoutTail).toContain("ordinary stdout");
    expect(record.evidence.stderrTail).toContain("ordinary stderr");
    expect(record.evidence.truncated).toBe(false);
  });

  it("produces a stdoutTail from a stdout-only error (empty stderr, exit 1)", () => {
    const record = classifyLlmResult(
      llmResult({ stdout: "trailing stdout content at the end", stderr: "", exitCode: 1, structuredOutput: {} }),
      CTX,
    );
    expect(record.evidence.stdoutTail).toContain("trailing stdout content at the end");
    expect(record.evidence.stderrTail).toBeUndefined();
  });

  it("truncates a 100 KB stderr to at most 8 KB with truncated: true", () => {
    const big = "x".repeat(100 * 1024);
    const record = classifyLlmResult(llmResult({ stderr: big, exitCode: 1, structuredOutput: {} }), CTX);
    expect(record.evidence.truncated).toBe(true);
    expect(Buffer.byteLength(record.evidence.stderrTail ?? "", "utf-8")).toBeLessThanOrEqual(EVIDENCE_TAIL_BYTES);
  });

  it("keeps a 1 KB stderr whole with truncated: false", () => {
    const small = "y".repeat(1024);
    const record = classifyLlmResult(llmResult({ stderr: small, exitCode: 1, structuredOutput: {} }), CTX);
    expect(record.evidence.truncated).toBe(false);
    expect(record.evidence.stderrTail).toBe(small);
  });

  it("redacts a secret sourced from process.env matching the _TOKEN/_KEY/_SECRET/_PASSWORD suffix rule", () => {
    vi.stubEnv("MY_SERVICE_TOKEN", "super-secret-value-123");
    const record = classifyLlmResult(
      llmResult({ stderr: "call failed, token=super-secret-value-123 rejected", exitCode: 1, structuredOutput: {} }),
      CTX,
    );
    expect(record.evidence.stderrTail).not.toContain("super-secret-value-123");
    expect(record.message).not.toContain("super-secret-value-123");
  });

  it("does not redact a short (<8 char) env value even if its key matches the _KEY/_TOKEN/_SECRET/_PASSWORD suffix rule", () => {
    // A short, common value like a branch name assigned to a *_KEY var must not
    // be treated as a secret and blanket-replaced across the evidence text.
    vi.stubEnv("FOO_KEY", "main");
    const record = classifyLlmResult(
      llmResult({ stderr: "checked out branch main successfully", exitCode: 1, structuredOutput: {} }),
      CTX,
    );
    expect(record.evidence.stderrTail).toContain("main");
    expect(record.message).toContain("main");
  });

  it("evidence capture failure still reports the original error and marks the record accordingly", () => {
    // Narrowly force the tail-building step to throw (only for this test's specific stderr
    // content, so unrelated Buffer.from callers — e.g. console.error's own internals — are
    // unaffected) to prove the classify* functions fall back rather than surface a raw
    // internal exception in place of the run's real failure.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalFrom = Buffer.from.bind(Buffer);
    const bufferSpy = vi.spyOn(Buffer, "from").mockImplementation(((input: unknown, encoding?: unknown) => {
      if (typeof input === "string" && input.includes("some stderr")) {
        throw new Error("boom");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalFrom as any)(input, encoding);
    }) as typeof Buffer.from);

    try {
      const record = classifyLlmResult(llmResult({ stderr: "some stderr", exitCode: 1 }), CTX);
      expect(record.category).toBe("unknown");
      expect(record.code).toBe("UNKNOWN");
      expect(record.evidence.truncated).toBe(true);
      expect(record.evidence.captureError).toContain("boom");
      expect(record.message).toContain("some stderr");
    } finally {
      bufferSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe("classifyGitFailure", () => {
  const GIT_CTX = { stage: "push", attempt: 1 };

  it('classifies "fatal error in commit_refs" as transient/GIT_REMOTE_TRANSIENT and keeps the original text in message', () => {
    const record = classifyGitFailure("remote: fatal error in commit_refs", 1, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
    expect(record.retryable).toBe(true);
    expect(record.message).toContain("commit_refs");
  });

  it("classifies a force-with-lease rejection as conflict/GIT_LEASE_REJECTED", () => {
    const record = classifyGitFailure(
      "! [rejected] HEAD -> ai-implement/eng-1 (stale info)",
      1,
      GIT_CTX,
    );
    expect(record.category).toBe("conflict");
    expect(record.code).toBe("GIT_LEASE_REJECTED");
    expect(record.retryable).toBe(false);
  });

  it("classifies an authentication failure as auth/GIT_AUTH", () => {
    const record = classifyGitFailure("fatal: Authentication failed for 'https://github.com/...'", 128, GIT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("returns unknown/UNKNOWN for unmatched git stderr", () => {
    const record = classifyGitFailure("something completely unrelated happened", 1, GIT_CTX);
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
    expect(record.retryable).toBe(false);
  });

  it("carries the exit status through as exitCode", () => {
    const record = classifyGitFailure("fatal: Authentication failed", 128, GIT_CTX);
    expect(record.exitCode).toBe(128);
  });

  it("classifies a 403 followed by 'remote end hung up unexpectedly' as auth/GIT_AUTH, not transient", () => {
    // git prints the generic transport trailer AFTER the real cause on a permission
    // failure: RPC failed; HTTP 403 ... fatal: the remote end hung up unexpectedly.
    // The generic transient row must not shadow GIT_AUTH just because it also matches.
    const record = classifyGitFailure(
      "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\n" +
        "fatal: the remote end hung up unexpectedly",
      128,
      GIT_CTX,
    );
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies a stderr carrying both an HTTP 403 and an unrelated 'Enumerating objects: 503' progress line as auth, not transient", () => {
    // The anchored 5xx row must not fire on git's own object-count progress counter,
    // and GIT_AUTH must win when a real auth marker is also present.
    const record = classifyGitFailure(
      "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\n" +
        "remote: Enumerating objects: 503, done.",
      128,
      GIT_CTX,
    );
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies a 401 the same way as a 403 (anchored)", () => {
    const record = classifyGitFailure(
      "error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401",
      128,
      GIT_CTX,
    );
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies a bare 503 alone as transient/GIT_REMOTE_TRANSIENT", () => {
    const record = classifyGitFailure("fatal: unable to access: The requested URL returned error: 503", 128, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies git's older 'HTTP code = 503' wording as transient/GIT_REMOTE_TRANSIENT", () => {
    const record = classifyGitFailure("error: RPC failed; result=22, HTTP code = 503", 1, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies git's older 'HTTP code = 403' wording followed by a hang-up as auth/GIT_AUTH, not transient", () => {
    // Old git never prints an "HTTP" status line for this failure — only the
    // "HTTP code = " wording — so the auth row's numeric test must anchor to it
    // too, or this falls through to the generic hung-up-unexpectedly transient row.
    const record = classifyGitFailure(
      "error: RPC failed; result=22, HTTP code = 403\nfatal: The remote end hung up unexpectedly",
      1,
      GIT_CTX,
    );
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies a bare 'remote: 403 Forbidden' as auth/GIT_AUTH", () => {
    // A proxy in front of GitHub can report the status with no "HTTP"/"RPC failed"/
    // "HTTP code =" marker at all — this must not fall through to unknown.
    const record = classifyGitFailure("remote: 403 Forbidden", 128, GIT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies a bare 'remote: 401 Unauthorized' as auth/GIT_AUTH", () => {
    const record = classifyGitFailure("remote: 401 Unauthorized", 128, GIT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it.each(["Forbidden", "Unauthorized"])("classifies '%s' alone on its own line as auth/GIT_AUTH", (word) => {
    const record = classifyGitFailure(`fatal: unable to access 'https://github.com/...'\n${word}`, 128, GIT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("classifies 'HTTP code=503' with no spaces as transient/GIT_REMOTE_TRANSIENT", () => {
    const record = classifyGitFailure("error: RPC failed; result=22, HTTP code=503", 1, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies the anchored auth and transient rows case-insensitively", () => {
    const auth = classifyGitFailure("error: rpc failed; http 403 the requested url returned error: 403", 128, GIT_CTX);
    expect(auth.category).toBe("auth");
    expect(auth.code).toBe("GIT_AUTH");

    const transient = classifyGitFailure("error: rpc failed; result=22, http code = 503", 1, GIT_CTX);
    expect(transient.category).toBe("transient");
    expect(transient.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies 'the remote end hung up unexpectedly' alone as transient", () => {
    const record = classifyGitFailure("fatal: the remote end hung up unexpectedly", 128, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies 'RPC failed; curl' alone as transient", () => {
    const record = classifyGitFailure("error: RPC failed; curl 56 Recv failure", 128, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies 'Connection reset by peer' alone as transient", () => {
    const record = classifyGitFailure("fatal: Connection reset by peer", 128, GIT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });

  it("classifies git's own object-count progress line as unknown, not transient, when a hook declines the push", () => {
    // "Enumerating objects: 503, done." is git's own progress counter, not a
    // transport status code — a bare-number test would otherwise misclassify this
    // pre-receive rejection as transient and get it retried.
    const record = classifyGitFailure(
      "Enumerating objects: 503, done.\nremote: error: pre-receive hook declined",
      1,
      GIT_CTX,
    );
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
  });

  it("classifies a force-with-lease wrapper carrying a real HTTP 503 as transient, not conflict", () => {
    // post-push-review's `git push --force-with-lease rejected: ...` wrapper fixes
    // the words "rejected" and "force-with-lease" onto every push failure, so an
    // actual transport 5xx underneath it must still win over the generic
    // lease-conflict wording.
    const record = classifyGitFailure(
      "git push --force-with-lease rejected: git push failed (exit 1): error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503\n" +
        "fatal: the remote end hung up unexpectedly",
      1,
      GIT_CTX,
    );
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });
});

describe("classifySpawnError", () => {
  it("includes llmSubtype: null, llmIsError: null, llmOutcome: null in evidence, matching every other record shape", () => {
    const err = Object.assign(new Error("spawn claude EAGAIN"), { code: "EAGAIN" });
    const record = classifySpawnError(err, { stage: "implement", attempt: 1 });
    expect(record.evidence.llmSubtype).toBeNull();
    expect(record.evidence.llmIsError).toBeNull();
    expect(record.evidence.llmOutcome).toBeNull();
  });

  it("classifies ENOENT as config (binary missing, not transient)", () => {
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const record = classifySpawnError(err, { stage: "implement", attempt: 1 });
    expect(record.category).toBe("config");
    expect(record.retryable).toBe(false);
  });

  it.each(["EAGAIN", "ENOMEM", "EPIPE"])("classifies %s as transient", (code) => {
    const err = Object.assign(new Error(`spawn claude ${code}`), { code });
    const record = classifySpawnError(err, { stage: "implement", attempt: 1 });
    expect(record.category).toBe("transient");
    expect(record.retryable).toBe(true);
  });

  it("falls back to NO_DETAIL_MESSAGE for a non-Error input with no usable text (pins the #122 merge's message fallback)", () => {
    const record = classifySpawnError("", { stage: "implement", attempt: 1 });
    expect(record.message).toBe(NO_DETAIL_MESSAGE);
  });
});

describe("classifyThrown", () => {
  const CT_CTX = { stage: "feedback-loop", attempt: 1 };

  it("passes through an already-attached FailureRecord instead of re-deriving from the message", () => {
    const attached: FailureRecord = {
      category: "transient",
      code: "PROVIDER_OVERLOADED",
      stage: "implement",
      attempt: 1,
      retryable: true,
      message: "overloaded",
      evidence: { truncated: false },
    };
    const err = Object.assign(new Error("LLM invocation failed with exit code 1"), { failure: attached });
    const record = classifyThrown(err, CT_CTX);
    expect(record).toBe(attached);
  });

  it("classifies a signal termination (code null, signal SIGTERM) as cancelled/PROCESS_SIGNALLED", () => {
    const err = { message: "child process killed", code: null, signal: "SIGTERM" };
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("cancelled");
    expect(record.code).toBe("PROCESS_SIGNALLED");
    expect(record.signal).toBe("SIGTERM");
    expect(record.retryable).toBe(false);
  });

  it("classifies a generic non-zero exit embedded in the message as crash/PROCESS_EXIT_NONZERO", () => {
    const err = new Error("git rev-list main..HEAD failed (exit 1): fatal: bad revision");
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("crash");
    expect(record.code).toBe("PROCESS_EXIT_NONZERO");
    expect(record.exitCode).toBe(1);
  });

  it("classifies a non-Error thrown value as unknown/UNKNOWN", () => {
    const record = classifyThrown("just a string", CT_CTX);
    expect(record.category).toBe("unknown");
    expect(record.code).toBe("UNKNOWN");
  });

  it("recognises a provider-style signature embedded in a thrown message", () => {
    const err = new Error("Review LLM invocation failed with exit code 1: HTTP 503 fetch failed");
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("PROVIDER_TRANSPORT");
    expect(record.retryable).toBe(true);
  });

  it("classifies a SensitiveFilesError (string `code`, no attached FailureRecord) as config/SENSITIVE_FILES_BLOCKED", () => {
    const err = Object.assign(
      new Error("Push blocked: 1 sensitive file(s) would be committed:\n  .env  (.env file)"),
      { code: "SENSITIVE_FILES_BLOCKED" },
    );
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("config");
    expect(record.code).toBe("SENSITIVE_FILES_BLOCKED");
    expect(record.retryable).toBe(false);
  });

  it("classifies a git push --force-with-lease 403 rejection as auth/GIT_AUTH, not PROVIDER_AUTH", () => {
    // post-push-review.ts fixes the words "rejected" and "force-with-lease" into
    // every push failure's message regardless of cause, so this message alone would
    // (without the GIT_AUTH-before-GIT_LEASE_REJECTED ordering) trip GIT_LEASE_REJECTED,
    // and (without gating GIT_SIGNATURES ahead of PROVIDER_SIGNATURES) trip PROVIDER_AUTH.
    const err = new Error(
      "git push --force-with-lease rejected: ! [remote rejected] HEAD -> branch (permission denied) " +
        "fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
    );
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("GIT_AUTH");
  });

  it("does not run GIT_SIGNATURES against a message that doesn't look like git output", () => {
    const err = new Error("provider returned 403: invalid x-api-key");
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("auth");
    expect(record.code).toBe("PROVIDER_AUTH");
  });

  it("classifies a git push --force-with-lease wrapper carrying an HTTP 503 as transient/GIT_REMOTE_TRANSIENT, not conflict", () => {
    // Same "rejected"/"force-with-lease" wrapper as the 403 case above, but this
    // time the underlying cause is a real transport 5xx — push now retries on
    // `transient`, so this must not get shadowed into a non-retried conflict.
    const err = new Error(
      "git push --force-with-lease rejected: git push failed (exit 1): error: RPC failed; HTTP 503 curl 22 " +
        "The requested URL returned error: 503\nfatal: the remote end hung up unexpectedly",
    );
    const record = classifyThrown(err, CT_CTX);
    expect(record.category).toBe("transient");
    expect(record.code).toBe("GIT_REMOTE_TRANSIENT");
  });
});

describe("redactEvidence", () => {
  it("removes a GitHub token that appears three times in one string via the explicit secrets list", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = `first ${token} second ${token} third ${token}`;
    const redacted = redactEvidence(text, [token]);
    expect(redacted).not.toContain(token);
    expect(redacted.match(/\*\*\*/g)).toHaveLength(3);
  });

  it("removes a sk-ant- key via the fixed pattern set even without an explicit secrets list", () => {
    const key = "sk-ant-api03-abc123DEF456-_xyz";
    const redacted = redactEvidence(`Authorization: Bearer ${key}`, []);
    expect(redacted).not.toContain(key);
  });

  it("removes a basic-auth URL", () => {
    const redacted = redactEvidence("https://x-access-token:ghs_abc123@github.com/org/repo.git", []);
    expect(redacted).not.toContain("ghs_abc123");
    expect(redacted).not.toContain("x-access-token:");
  });
});

describe("tailBytes", () => {
  it("keeps short text whole", () => {
    const { text, truncated } = tailBytes("hello", 1024);
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("truncates to the last `max` bytes", () => {
    const input = "0123456789";
    const { text, truncated } = tailBytes(input, 4);
    expect(text).toBe("6789");
    expect(truncated).toBe(true);
  });

  it("skips leading UTF-8 continuation bytes after slicing so a tail never starts with U+FFFD", () => {
    // 😀 is 4 bytes, followed by 3 ASCII bytes ("XYZ") = 7 bytes total. Slicing
    // to the last 6 bytes lands mid-codepoint (byte 1 of the emoji); the fix
    // must skip forward to the next real codepoint boundary rather than
    // decoding the fragment as U+FFFD.
    const input = "\u{1F600}XYZ";
    const { text, truncated } = tailBytes(input, 6);
    expect(truncated).toBe(true);
    expect(text).toBe("XYZ");
    expect(text.charCodeAt(0)).not.toBe(0xfffd);
  });
});

describe("isFailureRecord", () => {
  it("accepts a well-formed record", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false },
      }),
    ).toBe(true);
  });

  it("rejects a category outside the closed union", () => {
    expect(
      isFailureRecord({
        category: "bogus",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false },
      }),
    ).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(isFailureRecord(null)).toBe(false);
    expect(isFailureRecord("nope")).toBe(false);
  });

  it("rejects an array (Array.isArray guard)", () => {
    expect(isFailureRecord(["not", "a", "record"])).toBe(false);
  });

  it("rejects a record whose stdoutTail exceeds EVIDENCE_TAIL_BYTES", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, stdoutTail: "x".repeat(EVIDENCE_TAIL_BYTES + 1) },
      }),
    ).toBe(false);
  });

  it("rejects a record whose stderrTail exceeds EVIDENCE_TAIL_BYTES", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, stderrTail: "x".repeat(EVIDENCE_TAIL_BYTES + 1) },
      }),
    ).toBe(false);
  });

  it("accepts a record whose tail is exactly at the EVIDENCE_TAIL_BYTES cap", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, stdoutTail: "x".repeat(EVIDENCE_TAIL_BYTES) },
      }),
    ).toBe(true);
  });

  it("rejects a non-string stdoutTail even when short enough to pass a length check", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, stdoutTail: 12345 },
      }),
    ).toBe(false);
  });

  it("rejects a non-string stderrTail even when short enough to pass a length check", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, stderrTail: { not: "a string" } },
      }),
    ).toBe(false);
  });

  it("rejects a non-string captureError", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: true, captureError: 42 },
      }),
    ).toBe(false);
  });

  it("accepts a record whose llmOutcome is a recognised string or null", () => {
    for (const llmOutcome of ["success", "max_turns", "error", "unknown", null]) {
      expect(
        isFailureRecord({
          category: "transient",
          code: "X",
          stage: "s",
          attempt: 1,
          retryable: true,
          message: "m",
          evidence: { truncated: false, llmOutcome },
        }),
      ).toBe(true);
    }
  });

  it("rejects a non-string, non-null llmOutcome even when otherwise well-formed", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, llmOutcome: 42 },
      }),
    ).toBe(false);
  });

  it("rejects a string llmOutcome outside the closed RunTelemetry[\"outcome\"] union, e.g. a runner-callback body persisting an arbitrary value", () => {
    expect(
      isFailureRecord({
        category: "transient",
        code: "X",
        stage: "s",
        attempt: 1,
        retryable: true,
        message: "m",
        evidence: { truncated: false, llmOutcome: "bogus" },
      }),
    ).toBe(false);
  });
});

describe("projectFailureRecord", () => {
  it("drops unrecognised keys on both the record and its evidence", () => {
    const withExtras = {
      category: "transient",
      code: "X",
      stage: "s",
      attempt: 1,
      retryable: true,
      message: "m",
      evidence: { truncated: false, stdoutTail: "tail", sneaky: "nope" },
      alsoSneaky: "nope",
    } as unknown as FailureRecord;

    const projected = projectFailureRecord(withExtras);

    expect(projected).toEqual({
      category: "transient",
      code: "X",
      stage: "s",
      attempt: 1,
      retryable: true,
      message: "m",
      evidence: { truncated: false, stdoutTail: "tail" },
    });
    expect(projected).not.toHaveProperty("alsoSneaky");
    expect((projected.evidence as Record<string, unknown>)).not.toHaveProperty("sneaky");
  });

  it("preserves optional fields (exitCode, signal, elapsedMs) when present", () => {
    const record: FailureRecord = {
      category: "cancelled",
      code: "PROCESS_SIGNALLED",
      stage: "implement",
      attempt: 1,
      retryable: false,
      exitCode: null,
      signal: "SIGTERM",
      elapsedMs: 4200,
      message: "m",
      evidence: { truncated: false },
    };
    expect(projectFailureRecord(record)).toEqual(record);
  });
});
