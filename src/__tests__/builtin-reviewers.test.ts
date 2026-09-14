import { describe, expect, it } from "vitest";
import {
  BUILTIN_REVIEWER_VERDICT_SCHEMA,
  resolveReviewer,
  REVIEWER_VERDICT_SCHEMA,
  type ReviewerDefinition,
  type ReviewerPromptInput,
} from "../pipeline/reviewers/registry.js";

const input: ReviewerPromptInput = {
  issueIdentifier: "AII-665",
  issueTitle: "Add built-in reviewer definitions",
  issueDescription: "## Acceptance Criteria\n- Create gap-analysis\n- Create code-review",
  prNumber: "123",
  diff: "diff --git a/src/file.ts b/src/file.ts",
  previousFindings: "No previous findings.",
};

function keys(definition: ReviewerDefinition): string[] {
  return Object.keys(definition).sort();
}

describe("built-in reviewers", () => {
  it("resolves the gap-analysis and code-review built-ins", async () => {
    await expect(resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false }))
      .resolves.toMatchObject({ id: "gap-analysis" });
    await expect(resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false }))
      .resolves.toMatchObject({ id: "code-review" });
  });

  it("keeps the shared schema backward-compatible and uses a strict schema for built-ins", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(gap?.outputSchema).toBe(BUILTIN_REVIEWER_VERDICT_SCHEMA);
    expect(code?.outputSchema).toBe(BUILTIN_REVIEWER_VERDICT_SCHEMA);
    expect(REVIEWER_VERDICT_SCHEMA).toMatchObject({
      required: ["approved", "findings"],
      properties: {
        approved: { type: "boolean" },
        findings: { type: "array" },
        summary: { type: "string", minLength: 1 },
        checks: { type: "array", minItems: 1 },
      },
    });
    expect(BUILTIN_REVIEWER_VERDICT_SCHEMA).toMatchObject({
      required: ["approved", "findings", "summary", "checks"],
      properties: REVIEWER_VERDICT_SCHEMA.properties,
    });
  });

  it("does not let either built-in declare gates", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(keys(gap!)).toEqual(["buildPrompt", "id", "outputSchema"]);
    expect(keys(code!)).toEqual(["buildPrompt", "id", "outputSchema"]);
    expect("gates" in gap!).toBe(false);
    expect("gates" in code!).toBe(false);
  });

  it("leaves built-in turn caps to the retry policy default", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(gap?.maxTurns).toBeUndefined();
    expect(code?.maxTurns).toBeUndefined();
  });

  it("gap-analysis prompt is scoped to acceptance-criteria coverage", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const prompt = gap!.buildPrompt(input);

    expect(prompt).toContain("spec-coverage review only");
    expect(prompt).toContain("issue's acceptance criteria");
    expect(prompt).toContain("any requirement in the issue not implemented in the diff");
    expect(prompt).toContain("requirement from the issue acceptance criteria that has no implementation");
    expect(prompt).toContain("unrequested scope");
    expect(prompt).toContain("Do not report style problems, code defects, security issues, test gaps");
    expect(prompt).toContain("return a top-level checks JSON array and a concise plain-prose summary even when approved");
    expect(prompt).toContain("Each acceptance criterion should have a checks[] item");
    expect(prompt).toContain("include one scope check");
    expect(prompt).toContain("concrete acceptance criterion");
    expect(prompt).toContain("Use result=\"not_verified\"");
    expect(prompt).toContain("Distinguish inspecting test");
    expect(prompt).toContain("Do not claim tests were executed or runtime behavior was checked");
    expect(prompt).toContain("Do not put tool XML");
    expect(prompt).toContain("checks must be top-level");
    expect(prompt).toContain(input.issueDescription);
    expect(prompt).toContain(input.diff);
  });

  it("code-review prompt keeps defect review wording without requirements coverage", async () => {
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });
    const prompt = code!.buildPrompt(input);

    expect(prompt).toContain("Set approved=true only when no code changes are needed");
    expect(prompt).toContain("bug");
    expect(prompt).toContain("unsafe behavior");
    expect(prompt).toContain("test gap");
    expect(prompt).toContain("self-contained and immediately actionable");
    expect(prompt).toContain("Do not put praise, overall status, or optional/future cleanup");
    expect(prompt).toContain("On follow-up reviews, first verify every previous issue is fixed");
    expect(prompt).toContain("changed API/data contracts, error handling");
    expect(prompt).toContain("return a top-level checks JSON array and a concise plain-prose summary even when approved");
    expect(prompt).toContain("such as changed");
    expect(prompt).toContain("behavior, edge cases, contracts, security, and tests");
    expect(prompt).toContain("Use result=\"not_verified\"");
    expect(prompt).toContain("Distinguish inspecting test source from executing");
    expect(prompt).toContain("Do not claim runtime tests, browser checks, or");
    expect(prompt).toContain("Do not put tool XML");
    expect(prompt).toContain("checks must be top-level");
    expect(prompt).toContain("Findings remain");
    expect(prompt).not.toContain("missing requirement");
    expect(prompt).not.toContain("check requirements coverage");
    expect(prompt).not.toContain("acceptance criteria");
  });
});
