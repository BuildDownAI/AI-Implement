import { describe, it, expect } from "vitest";
import { workflowFileForJob } from "../monitor-status.js";

const mapping = { workflowFile: "claude-implement.yml", planningWorkflowFile: "claude-plan.yml" };

describe("workflowFileForJob", () => {
  it("returns the planning workflow for planning-phase jobs", () => {
    expect(workflowFileForJob({ phase: "planning" }, mapping)).toBe("claude-plan.yml");
  });

  it("returns the implementation workflow for implementation-phase jobs", () => {
    expect(workflowFileForJob({ phase: "implementation" }, mapping)).toBe("claude-implement.yml");
  });

  it("returns the implementation workflow for legacy rows with no phase", () => {
    expect(workflowFileForJob({ phase: null }, mapping)).toBe("claude-implement.yml");
  });

  it("falls back to the implementation workflow when planningWorkflowFile is unset", () => {
    expect(
      workflowFileForJob({ phase: "planning" }, { workflowFile: "claude-implement.yml", planningWorkflowFile: null }),
    ).toBe("claude-implement.yml");
  });
});
