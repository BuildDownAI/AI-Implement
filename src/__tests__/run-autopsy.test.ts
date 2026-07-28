import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, type RunAutopsy } from "../run-autopsy.js";

const AUTOPSY: RunAutopsy = {
  issueIdentifier: "DF-6",
  terminationReason: "iterations_exhausted",
  iterations: 3,
  finalFeedback: "Missing provider wiring.",
  passes: [{ iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewApproved: false }],
  postMortem: "## Post-mortem\nScope too broad.",
  prUrl: "https://github.com/acme/app/pull/9",
};

describe("formatRunAutopsy", () => {
  it("renders reason, stats, feedback, post-mortem, and PR link", () => {
    const md = formatRunAutopsy(AUTOPSY);
    expect(md).toContain("DF-6");
    expect(md).toContain("iterations_exhausted");
    expect(md).toContain("3 iteration(s)");
    expect(md).toContain("Missing provider wiring.");
    expect(md).toContain("| 1 | success | 98 | $3.21 | rejected |");
    expect(md).toContain("Post-mortem");
    expect(md).toContain("https://github.com/acme/app/pull/9");
  });

  it("notes when no PR could be opened", () => {
    const md = formatRunAutopsy({ ...AUTOPSY, prUrl: undefined });
    expect(md).toContain("No PR could be opened");
  });
});

describe("writeRunAutopsy", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes ai-output/comments/90-run-autopsy.md", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    writeRunAutopsy(dir, AUTOPSY);
    const path = join(dir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("DF-6");
  });

  it("never throws on an unwritable directory", () => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-"));
    expect(() => writeRunAutopsy("/nonexistent-root-path/nope", AUTOPSY)).not.toThrow();
  });
});
