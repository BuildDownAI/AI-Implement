import { describe, expect, it } from "vitest";
import {
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

  it("uses one shared output schema for both built-ins", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(gap?.outputSchema).toBe(REVIEWER_VERDICT_SCHEMA);
    expect(code?.outputSchema).toBe(REVIEWER_VERDICT_SCHEMA);
    expect(REVIEWER_VERDICT_SCHEMA).toMatchObject({
      required: ["approved", "findings"],
      properties: {
        approved: { type: "boolean" },
        findings: { type: "array" },
      },
    });
  });

  it("does not let either built-in declare gates", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(keys(gap!)).toEqual(["buildPrompt", "id", "maxTurns", "outputSchema"]);
    expect(keys(code!)).toEqual(["buildPrompt", "id", "outputSchema"]);
    expect("gates" in gap!).toBe(false);
    expect("gates" in code!).toBe(false);
  });

  it("caps gap-analysis turns and leaves code-review uncapped for the retry policy default", async () => {
    const gap = await resolveReviewer("gap-analysis", { customRoot: "/workspace", existsSyncImpl: () => false });
    const code = await resolveReviewer("code-review", { customRoot: "/workspace", existsSyncImpl: () => false });

    expect(gap?.maxTurns).toBeGreaterThan(0);
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
    expect(prompt).not.toContain("missing requirement");
    expect(prompt).not.toContain("check requirements coverage");
    expect(prompt).not.toContain("acceptance criteria");
  });
});
