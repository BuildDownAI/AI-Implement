import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunAutopsy, writeRunAutopsy, formatRunStats, type RunAutopsy } from "../run-autopsy.js";

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

const STAT_PASSES = [{ iteration: 1, implementTurns: 42, implementOutcome: "success", costUsd: 1.5, reviewApproved: true }];

describe("formatRunStats — planned-vs-actual delta", () => {
  it("shows all-touched message when planned and changed sets are identical", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts", "src/b.ts"],
    });
    expect(md).toContain("All planned files were touched");
    expect(md).not.toContain("Unplanned files touched");
    expect(md).not.toContain("Planned files not touched");
  });

  it("lists unplanned files touched when filesChanged has extras", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts"],
      filesChanged: ["src/a.ts", "src/extra.ts"],
    });
    expect(md).toContain("Unplanned files touched");
    expect(md).toContain("`src/extra.ts`");
    expect(md).not.toContain("Planned files not touched");
  });

  it("lists planned files not touched when filesChanged is missing entries", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts"],
    });
    expect(md).toContain("Planned files not touched");
    expect(md).toContain("`src/b.ts`");
    expect(md).not.toContain("Unplanned files touched");
  });

  it("lists both sections when sets partially overlap", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: ["src/a.ts", "src/extra.ts"],
    });
    expect(md).toContain("Unplanned files touched");
    expect(md).toContain("`src/extra.ts`");
    expect(md).toContain("Planned files not touched");
    expect(md).toContain("`src/b.ts`");
  });

  it("omits planned-vs-actual section entirely when plannedFiles is empty", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: [],
      filesChanged: ["src/a.ts"],
    });
    expect(md).not.toContain("Planned vs actual");
  });

  it("omits planned-vs-actual section when filesChanged is null (diff unavailable)", () => {
    const md = formatRunStats({
      issueIdentifier: "AII-1",
      passes: STAT_PASSES,
      plannedFiles: ["src/a.ts", "src/b.ts"],
      filesChanged: null,
    });
    expect(md).not.toContain("Planned vs actual");
    expect(md).not.toContain("Planned files not touched");
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
