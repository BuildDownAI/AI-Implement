// Default suite, no Docker: the Restate sequencer weighs a file by its same-folder imports (AII-1166).
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { RestateSequencer, weightOf } from "../../vitest.restate.sequencer.js";

const DIR = join(import.meta.dirname, "restate");
const file = (name: string) => join(DIR, name);

describe("weightOf", () => {
  it("ranks both kg-refresh split files above review-fix-pilot", () => {
    const pilot = weightOf(file("review-fix-pilot.restate.test.ts"));
    expect(weightOf(file("kg-refresh-workflow-always-replay.restate.test.ts"))).toBeGreaterThan(pilot);
    expect(weightOf(file("kg-refresh-workflow-disable-retries.restate.test.ts"))).toBeGreaterThan(pilot);
  });

  it("weighs a file with no same-folder import at its own size", () => {
    const path = file("binary-environment.ts");
    expect(weightOf(path)).toBe(statSync(path).size);
  });

  it("counts a missing file as 0", () => {
    expect(weightOf(file("does-not-exist.ts"))).toBe(0);
  });
});

describe("RestateSequencer", () => {
  it("starts the split files first", async () => {
    const names = [
      "review-fix-pilot.restate.test.ts",
      "planning-run-pilot.restate.test.ts",
      "kg-refresh-workflow-always-replay.restate.test.ts",
      "kg-refresh-workflow-disable-retries.restate.test.ts",
    ];
    // The base order needs live project specs; stub it to the input order so only the weight pass is under test.
    vi.spyOn(BaseSequencer.prototype, "sort").mockImplementation(async (files) => [...files]);
    const sequencer = new RestateSequencer({} as never);
    const specs = names.map((n) => ({ moduleId: file(n) }) as TestSpecification);
    const first = (await sequencer.sort(specs)).slice(0, 2).map((s) => s.moduleId);
    expect(first.every((m) => m.includes("kg-refresh-workflow-"))).toBe(true);
    vi.restoreAllMocks();
  });
});
