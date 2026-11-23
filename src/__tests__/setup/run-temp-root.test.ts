// The test run's temp directory and its checks (run-temp-root.ts), called directly rather than through vitest's globalSetup and the scrub.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import setupRunTempRoot, { endFileTempRoot, startFileTempRoot } from "./run-temp-root.js";

// The scrub imports the helper before this test; reload it with the filesystem mocks.
const fsFailure = vi.hoisted(() => {
  vi.resetModules();
  return { path: "", operation: "" };
});

// Inject filesystem failures deterministically, including when tests run as root.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync).mockImplementation((...args) => {
      if (args[0] === fsFailure.path && fsFailure.operation === "read") throw new Error("EACCES: permission denied");
      return actual.readdirSync(...args);
    }),
    lstatSync: vi.fn(actual.lstatSync).mockImplementation((...args) => {
      if (args[0] === fsFailure.path && fsFailure.operation === "stat") throw new Error("EACCES: permission denied");
      return actual.lstatSync(...args);
    }),
  };
});

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

  it("fails the run even when emitting diagnostics throws", () => {
    const { root, teardown } = startRun();
    writeFileSync(join(root, "left-behind.txt"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("diagnostic failure"); });
    onTestFinished(() => error.mockRestore());

    expect(teardown).toThrow("diagnostic failure");
    expect(process.exitCode).toBe(1);
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

// Both teardown paths use the same bounded listing, relative to the checked root.
describe.each(["file", "run"] as const)("%s leftover diagnostics", scope => {
  function fixture() {
    const { root, teardown } = startRun();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    return { root, message: () => {
      if (scope === "run") {
        teardown();
        expect(process.exitCode).toBe(1);
        const message = String(error.mock.calls[0]?.[0]);
        expect(message).toContain("Left in the test run's temp directory");
        return message.split("for inspection: ")[1];
      }
      expect(() => endFileTempRoot(root)).toThrow("Left in this test file's temp directory");
      try { endFileTempRoot(root); } catch (cause) {
        return (cause as Error).message.split("for inspection: ")[1];
      }
      throw new Error("Expected leftovers to fail");
    } };
  }

  describe.each(["left", join("left", "nested")])("unreadable %s", relative => {
    it.each(["read", "stat"] as const)("keeps the failure prefix and relative path when a %s fails", operation => {
      const { root, message } = fixture();
      const unreadable = join(root, relative);
      mkdirSync(unreadable, { recursive: true });
      writeFileSync(join(root, "left", "z.txt"), "");
      fsFailure.path = unreadable;
      fsFailure.operation = operation;
      onTestFinished(() => { fsFailure.path = ""; fsFailure.operation = ""; });

      expect(message()).toBe(relative === "left" ? "left: unreadable entry" : `${relative}: unreadable entry, ${join("left", "z.txt")}`);
      expect(existsSync(unreadable)).toBe(true);
    });
  });

  it("lists sorted nested paths and does not follow symbolic links", () => {
    const { root, message } = fixture();
    mkdirSync(join(root, "left", "nested"), { recursive: true });
    mkdirSync(join(root, "left", "empty"));
    writeFileSync(join(root, "left", "z.txt"), "");
    writeFileSync(join(root, "left", "nested", "b.txt"), "");
    writeFileSync(join(root, "left", "nested", "a.txt"), "");
    symlinkSync(join(root, "left"), join(root, "link"), "junction");
    writeFileSync(join(root, "plain.txt"), "");
    expect(message()).toBe([
      join("left", "empty"), join("left", "nested", "a.txt"),
      join("left", "nested", "b.txt"), join("left", "z.txt"), "link", "plain.txt",
    ].join(", "));
    expect(existsSync(join(root, "left", "z.txt"))).toBe(true);
  });

  it.each([20, 21])("limits each top entry independently with %i files", count => {
    const { root, message } = fixture();
    const expected: string[] = [];
    for (const top of ["first", "second"]) {
      mkdirSync(join(root, top));
      for (let index = count - 1; index >= 0; index--) {
        writeFileSync(join(root, top, `${String(index).padStart(2, "0")}.txt`), "");
      }
      for (let index = 0; index < 20; index++) expected.push(join(top, `${String(index).padStart(2, "0")}.txt`));
      if (count > 20) expected.push(`${top}: more paths exist`);
    }
    expect(message()).toBe(expected.join(", "));
  });
});
