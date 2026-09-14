import { execFile as rawExecFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveLocalContainerLogs,
  archiveLocalContainerLogsBestEffort,
  LOCAL_JOB_LOG_LINES,
  LOCAL_JOB_LOG_MAX_CHARS,
  readLocalJobLogs,
} from "../local-job-logs.js";

vi.mock("../dedup.js", () => ({
  getDb: () => ({ name: "/tmp/ai-implement-test/dedup.sqlite" }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
  readFile: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function mockExecFile(stdoutByArgs: (args: string[]) => string): void {
  vi.mocked(rawExecFile).mockImplementation(
    (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: stdoutByArgs(args as string[]),
        stderr: "",
      });
      return {} as ReturnType<typeof rawExecFile>;
    },
  );
}

describe("local job log storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DEDUP_DB_PATH", "/tmp/ai-implement-test/dedup.sqlite");
    vi.stubEnv("LOCAL_LOG_TEST_KEY", "secret-value-123");
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    vi.mocked(open).mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) } as never);
  });

  it("reads live Docker logs with bounded tail and redaction", async () => {
    mockExecFile(() => "line 1\nsecret-value-123\n");

    const result = await readLocalJobLogs("a".repeat(64));

    expect(result).toEqual({ logs: "line 1\n***", source: "live" });
    expect(rawExecFile).toHaveBeenCalledWith(
      "docker",
      ["logs", "--tail", String(LOCAL_JOB_LOG_LINES), "a".repeat(64)],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 512 * 1024 }),
      expect.any(Function),
    );
  });

  it("falls back to the saved log after the container is gone", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error("no such container"));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );
    vi.mocked(lstat).mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 11,
    } as never);
    vi.mocked(readFile).mockResolvedValue("saved lines");

    const result = await readLocalJobLogs("b".repeat(64));

    expect(result).toEqual({ logs: "saved lines", source: "saved" });
    expect(readFile).toHaveBeenCalledWith("/tmp/ai-implement-test/local-runner-logs/" + "b".repeat(64) + ".log", "utf-8");
  });

  it("returns null when neither live nor saved logs exist", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error("no such container"));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await expect(readLocalJobLogs("c".repeat(64))).resolves.toBeNull();
  });

  it("rejects unsafe container ids before Docker or filesystem access", async () => {
    await expect(readLocalJobLogs("../bad")).rejects.toThrow("Invalid local Docker container id");
    await expect(archiveLocalContainerLogs("../bad")).rejects.toThrow("Invalid local Docker container id");
    expect(rawExecFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("archives redacted capped logs under both short and canonical full ids before removal", async () => {
    const full = "d".repeat(64);
    mockExecFile((args) => args[0] === "logs" ? `${"x".repeat(LOCAL_JOB_LOG_MAX_CHARS + 10)}secret-value-123` : `${full}\n`);

    await archiveLocalContainerLogs("d".repeat(12));

    expect(mkdir).toHaveBeenCalledWith("/tmp/ai-implement-test/local-runner-logs", { recursive: true, mode: 0o700 });
    expect(open).toHaveBeenCalled();
    const payloads = vi.mocked(writeFile).mock.calls.map((call) => String(call[1]));
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.length <= LOCAL_JOB_LOG_MAX_CHARS)).toBe(true);
    expect(payloads.every((payload) => !payload.includes("secret-value-123"))).toBe(true);
    expect(vi.mocked(rename).mock.calls.some((call) => String(call[1]).endsWith(`${full}.log`))).toBe(true);
    expect(vi.mocked(rename).mock.calls.some((call) => String(call[1]).endsWith(`${"d".repeat(12)}.log`))).toBe(true);
    expect(chmod).toHaveBeenCalled();
  });

  it("does not throw from best-effort archive failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(Object.assign(new Error("docker unavailable"), { stderr: "secret-value-123" }));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await expect(archiveLocalContainerLogsBestEffort("e".repeat(64))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to archive logs before removing container"));
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).not.toContain("secret-value-123");
    vi.mocked(console.warn).mockRestore();
  });

  it("does not read saved logs through symlinks", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error("no such container"));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );
    vi.mocked(lstat).mockResolvedValue({
      isFile: () => false,
      isSymbolicLink: () => true,
      size: 0,
    } as never);

    await expect(readLocalJobLogs("f".repeat(64))).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("redacts saved logs before returning them", async () => {
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error("no such container"));
        return {} as ReturnType<typeof rawExecFile>;
      },
    );
    vi.mocked(lstat).mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 22,
    } as never);
    vi.mocked(readFile).mockResolvedValue("saved secret-value-123");

    await expect(readLocalJobLogs("1".repeat(64))).resolves.toEqual({ logs: "saved ***", source: "saved" });
  });

  it("cleans up temp files when archive write fails", async () => {
    mockExecFile((args) => args[0] === "logs" ? "logs" : `${"a".repeat(64)}\n`);
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));

    await expect(archiveLocalContainerLogs("a".repeat(64))).rejects.toThrow("rename failed");
    expect(unlink).toHaveBeenCalled();
  });
});
