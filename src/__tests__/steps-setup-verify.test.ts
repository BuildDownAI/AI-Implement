import { describe, it, expect, beforeEach } from "vitest";

const isWindows = process.platform === "win32";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupStep } from "../pipeline/steps/setup.js";
import { verifyStep } from "../pipeline/steps/verify.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { makeContext } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

let dir: string;
beforeEach(() => { dir = testDir("sv"); });

describe.skipIf(isWindows)("setupStep", () => {
  it("runs the setup script and returns ran:true", async () => {
    writeFileSync(join(dir, "s.sh"), "echo hi\n");
    const out = await setupStep.run(makeContext(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter());
    expect(out.ran).toBe(true);
  });
  it("throws when the setup script fails", async () => {
    writeFileSync(join(dir, "s.sh"), "exit 1\n");
    await expect(
      setupStep.run(makeContext(), { workspaceDir: dir, scriptPath: "s.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/setup/i);
  });
});

describe.skipIf(isWindows)("verifyStep", () => {
  it("throws when the verify script fails", async () => {
    writeFileSync(join(dir, "v.sh"), "exit 2\n");
    await expect(
      verifyStep.run(makeContext(), { workspaceDir: dir, scriptPath: "v.sh" }, new NoopStepReporter()),
    ).rejects.toThrow(/verify/i);
  });
});
