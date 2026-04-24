import { describe, it, expect, vi, beforeEach } from "vitest";
import { preflightStep } from "../pipeline/steps/preflight.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { execSync } from "node:child_process";
import fs from "node:fs";

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
  });
}

describe("preflightStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no-op summary when no package.json scripts configured", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const outputs = await preflightStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.passed).toBe(true);
    expect(outputs.summary).toBe("no preflight checks configured");
    expect(outputs.testsRun).toBe(0);
    expect(outputs.testOutput).toBe("");
    expect(execSync).not.toHaveBeenCalled();
  });

  it("runs typecheck, lint, and test when all scripts defined", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith("package.json"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest" } }),
    );
    vi.mocked(execSync).mockReturnValue(Buffer.from("ok"));

    const outputs = await preflightStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test", packageManager: "npm" },
      new NoopStepReporter(),
    );

    expect(outputs.passed).toBe(true);
    expect(outputs.summary).toContain("typecheck");
    expect(outputs.summary).toContain("lint");
    expect(outputs.summary).toContain("tests");
    expect(execSync).toHaveBeenCalledTimes(3);
  });

  it("sets passed=false when a check command fails", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith("package.json"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ scripts: { typecheck: "tsc" } }),
    );
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("type errors found");
    });

    const outputs = await preflightStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.passed).toBe(false);
    expect(outputs.testOutput).toContain("type errors found");
    expect(outputs.summary).toContain("typecheck: failed");
  });

  it("uses yarn run for yarn package manager", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith("package.json"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ scripts: { typecheck: "tsc" } }),
    );
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));

    await preflightStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test", packageManager: "yarn" },
      new NoopStepReporter(),
    );

    expect(execSync).toHaveBeenCalledWith("yarn typecheck", expect.anything());
  });

  it("includes testOutput and testsRun in outputs", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith("package.json"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    vi.mocked(execSync).mockReturnValue(Buffer.from("3 pass\n1 pass\n"));

    const outputs = await preflightStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(typeof outputs.testOutput).toBe("string");
    expect(typeof outputs.testsRun).toBe("number");
  });
});
