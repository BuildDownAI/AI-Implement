import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbName = vi.hoisted(() => ({ value: "" }));

vi.mock("../dedup.js", () => ({
  getDb: () => ({ name: dbName.value }),
}));

async function mode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

describe("local job log storage filesystem behavior", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-implement-local-logs-"));
    dbName.value = path.join(tmp, "fallback.sqlite");
    vi.stubEnv("DEDUP_DB_PATH", path.join(tmp, "configured", "configured.sqlite"));
    vi.stubEnv("LOCAL_JOB_LOG_FS_SECRET", "secret-value-456");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("archives and reads saved redacted logs beside the opened DB with private modes", async () => {
    const { archiveLocalContainerLogs, readLocalJobLogs } = await import("../local-job-logs.js");
    const id = "a".repeat(64);

    await archiveLocalContainerLogs(id, async () => "line one\nsecret-value-456\n");
    const result = await readLocalJobLogs(id, async () => { throw new Error("container removed"); });

    expect(result).toEqual({ logs: "line one\n***", source: "saved" });
    const logsDir = path.join(tmp, "local-runner-logs");
    const logFile = path.join(logsDir, `${id}.log`);
    await expect(fs.access(logFile)).resolves.toBeUndefined();
    expect(await mode(logsDir)).toBe(0o700);
    expect(await mode(logFile)).toBe(0o600);
    await expect(fs.access(path.join(path.dirname(process.env.DEDUP_DB_PATH!), "local-runner-logs"))).rejects.toThrow();
  });

  it("refuses a symlinked logs directory on archive and read", async () => {
    const { archiveLocalContainerLogs, readLocalJobLogs } = await import("../local-job-logs.js");
    const id = "b".repeat(64);
    await fs.mkdir(path.join(tmp, "real"));
    await fs.symlink(path.join(tmp, "real"), path.join(tmp, "local-runner-logs"));

    await expect(archiveLocalContainerLogs(id, async () => "logs")).rejects.toThrow("Local runner logs directory is not a normal directory");
    await expect(readLocalJobLogs(id, async () => { throw new Error("container removed"); })).rejects.toThrow(/ELOOP|not a directory|too many/i);
  });
});
