import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStep } from "../pipeline/steps/setup.js";
import { verifyStep } from "../pipeline/steps/verify.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor } from "../pipeline/types.js";

const noopExec: LLMExecutor = { async invoke() { return { stdout: "", exitCode: 0, tokensUsed: 0 }; } };
function ctx() {
  return new DefaultPipelineContext(
    { jobId: 1, issueId: "i", issueIdentifier: "ENG-1", issueTitle: "T", issueDescription: "D", nonce: "n", orchestratorUrl: "", ticketingProvider: "linear" },
    noopExec,
  );
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sv-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("setupStep", () => {
  it("runs the setup script and returns ran:true", async () => {
    writeFileSync(join(dir, "s.sh"), "echo hi\n");
    const out = await setupStep.run(ctx(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter());
    expect(out.ran).toBe(true);
  });
  it("throws when the setup script fails", async () => {
    writeFileSync(join(dir, "s.sh"), "exit 1\n");
    await expect(
      setupStep.run(ctx(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/setup/i);
  });
});

describe("verifyStep", () => {
  it("throws when the verify script fails", async () => {
    writeFileSync(join(dir, "v.sh"), "exit 2\n");
    await expect(
      verifyStep.run(ctx(), { workspaceDir: dir, scriptPath: "v.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/verify/i);
  });
});
