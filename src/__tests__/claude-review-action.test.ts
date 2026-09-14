import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const action = parse(readFileSync(".github/actions/claude-review/action.yml", "utf8"));
const steps = action.runs.steps as Array<{ name: string; id?: string; run?: string; with?: { claude_args?: string } }>;

function getStep(name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing action step: ${name}`);
  return step;
}

function runRenderStep(structuredOutput: string) {
  const tempRoot = mkdtempSync(join(tmpdir(), "claude-review-action-"));
  const binDir = join(tempRoot, "bin");
  const runnerTemp = join(tempRoot, "runner");
  const scriptPath = join(tempRoot, "render.sh");
  const ghPath = join(binDir, "gh");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" > "$RUNNER_TEMP/gh-args.txt"',
      'body_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--body-file" ]; then',
      '    body_file="$2"',
      "    break",
      "  fi",
      "  shift",
      "done",
      'test -n "$body_file"',
      'cp "$body_file" "$RUNNER_TEMP/posted-body.md"',
      "",
    ].join("\n"),
  );
  chmodSync(ghPath, 0o755);

  writeFileSync(scriptPath, getStep("Render and post review comment").run ?? "");
  chmodSync(scriptPath, 0o755);

  const result = spawnSync("bash", [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      STRUCTURED_OUTPUT: structuredOutput,
      RUNNER_TEMP: runnerTemp,
      GH_TOKEN: "test-token",
      PR_NUMBER: "123",
    },
    encoding: "utf8",
  });

  return {
    ...result,
    runnerTemp,
    ghArgs: tryRead(join(runnerTemp, "gh-args.txt")),
    postedBody: tryRead(join(runnerTemp, "posted-body.md")),
  };
}

function tryRead(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseReviewFindingsBlock(body: string) {
  const matches = [...body.matchAll(/```json[ \t]+review-findings[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/g)];
  const json = matches.at(-1)?.[1];
  if (json === undefined) throw new Error("Missing review-findings block");
  return JSON.parse(json);
}

describe("Claude review action", () => {
  it("passes Claude a compact schema JSON literal instead of a file path", () => {
    const prepareSchema = getStep("Prepare review findings schema");
    const runReview = getStep("Run Claude review");

    expect(prepareSchema.run).toContain('jq -c \'del(.. | .description?)\' "${{ github.action_path }}/review-findings-schema.json"');
    expect(runReview.with?.claude_args).toContain("--json-schema '${{ steps.prepare-schema.outputs.json }}'");
    expect(runReview.with?.claude_args).not.toContain("--json-schema \"${{ github.action_path }}");
  });

  it("renders an approving verdict into the human text and the machine block", () => {
    const result = runRenderStep(
      JSON.stringify({
        verdict: "approve",
        summary: "Ready to merge.",
        findings: [],
      }),
    );

    expect(result.status).toBe(0);
    expect(result.ghArgs).toContain("pr comment 123 --body-file");
    expect(result.postedBody).toContain("**Verdict:** approve");
    expect(result.postedBody).toContain("No findings reported.");
    expect(parseReviewFindingsBlock(result.postedBody ?? "")).toEqual({
      schema: "review-findings/v1",
      verdict: "approve",
      findings: [],
    });
  });

  it("preserves changes_requested findings with path, line, and markdown body", () => {
    const body = "Use the existing `parseJson` helper and keep **one** parser path.";
    const result = runRenderStep(
      JSON.stringify({
        verdict: "changes_requested",
        summary: "One blocking parser issue remains.",
        findings: [{ severity: "blocking", path: "src/review.ts", line: 42, body }],
      }),
    );

    expect(result.status).toBe(0);
    expect(result.postedBody).toContain("- **[blocking]** (src/review.ts:42): Use the existing `parseJson` helper");
    expect(parseReviewFindingsBlock(result.postedBody ?? "")).toEqual({
      schema: "review-findings/v1",
      verdict: "changes_requested",
      findings: [{ severity: "blocking", path: "src/review.ts", line: 42, body }],
    });
  });

  it("renders incomplete verdicts as a valid contract block", () => {
    const result = runRenderStep(
      JSON.stringify({
        verdict: "incomplete",
        summary: "The reviewer could not reach a trustworthy verdict.",
        findings: [],
      }),
    );

    expect(result.status).toBe(0);
    expect(parseReviewFindingsBlock(result.postedBody ?? "")).toEqual({
      schema: "review-findings/v1",
      verdict: "incomplete",
      findings: [],
    });
  });

  it("fails before posting when structured_output is not JSON", () => {
    const result = runRenderStep("{not json");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("structured_output was not valid JSON");
    expect(result.ghArgs).toBeUndefined();
    expect(result.postedBody).toBeUndefined();
  });

  it("fails before posting when structured_output does not match the trusted schema", () => {
    const result = runRenderStep(
      JSON.stringify({
        verdict: "request_changes",
        summary: "Old verdict spelling should not pass.",
        findings: [{ severity: "blocking", title: "Old shape", location: "src/x.ts:1", body: "Wrong finding keys." }],
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("structured_output did not match review-findings/v1");
    expect(result.ghArgs).toBeUndefined();
    expect(result.postedBody).toBeUndefined();
  });
});
