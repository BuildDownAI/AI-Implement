// The test run's temp directory and its checks (run-temp-root.ts), called directly rather than through vitest's globalSetup and the scrub.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import setupRunTempRoot, { endFileTempRoot, startFileTempRoot } from "./run-temp-root.js";

function startRun(): { root: string; teardown: () => void } {
  const provided = new Map<string, string>();
  const teardown = setupRunTempRoot({ provide: (key, value) => void provided.set(key, value) });
  const root = provided.get("runTempRoot") ?? "";
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const exitCode = process.exitCode;
  onTestFinished(() => {
    process.exitCode = exitCode;
  });
  return { root, teardown };
}

describe("the run's temp directory", () => {
  it("is a new directory under the machine's temp directory, removed at the end with the exit code untouched", () => {
    const { root, teardown } = startRun();
    expect(dirname(root)).toBe(tmpdir());
    expect(basename(root)).toMatch(/^ai-implement-run-/);
    expect(existsSync(root)).toBe(true);

    const exitCode = process.exitCode;
    teardown();
    expect(existsSync(root)).toBe(false);
    expect(process.exitCode).toBe(exitCode);
  });

  it("names what was left inside it, fails the run, and keeps it for inspection", () => {
    const { root, teardown } = startRun();
    writeFileSync(join(root, "left-behind.txt"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());

    teardown();

    expect(process.exitCode).toBe(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain(root);
    expect(message).toContain("left-behind.txt");
    expect(existsSync(join(root, "left-behind.txt"))).toBe(true);
  });

  it("removes the empty directory of a file that never ran its check, and keeps one with something in it", () => {
    const { root, teardown } = startRun();
    const skipped = startFileTempRoot(root, "all-skipped.test.ts");
    const failedToLoad = startFileTempRoot(root, "failed-to-load.test.ts");
    writeFileSync(join(failedToLoad, "left-behind.txt"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());

    teardown();

    expect(existsSync(skipped)).toBe(false);
    expect(existsSync(join(failedToLoad, "left-behind.txt"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(basename(failedToLoad));
  });

  it("removes itself when every directory left in it is empty", () => {
    const { root, teardown } = startRun();
    startFileTempRoot(root, "all-skipped.test.ts");
    const exitCode = process.exitCode;

    teardown();

    expect(existsSync(root)).toBe(false);
    expect(process.exitCode).toBe(exitCode);
  });
});

describe("a test file's temp directory", () => {
  const runRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "ai-implement-run-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };

  it("is a new directory inside the run's, named after its file, removed when its file leaves it empty", () => {
    const root = runRoot();
    const dir = startFileTempRoot(root, join("src", "__tests__", "some.test.ts"));
    expect(dirname(dir)).toBe(root);
    expect(basename(dir)).toMatch(/^some\.test\.ts-/);

    endFileTempRoot(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("fails its file, naming what was left, and keeps it for inspection", () => {
    const dir = startFileTempRoot(runRoot(), "some.test.ts");
    writeFileSync(join(dir, "left-behind.txt"), "");

    expect(() => endFileTempRoot(dir)).toThrow(dir);
    expect(() => endFileTempRoot(dir)).toThrow("left-behind.txt");
    expect(existsSync(join(dir, "left-behind.txt"))).toBe(true);
  });
});
