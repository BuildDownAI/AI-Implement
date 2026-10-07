import { execFile as rawExecFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveLocalContainerLogsBestEffortMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../local-job-logs.js", () => ({
  archiveLocalContainerLogsBestEffort: archiveLocalContainerLogsBestEffortMock,
}));

import { removeLocalContainer, stopLocalContainer } from "../local-docker.js";

describe("removeLocalContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, _args: unknown, cb: unknown) => {
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );
  });

  it("archives logs before removing the container", async () => {
    const calls: string[] = [];
    archiveLocalContainerLogsBestEffortMock.mockImplementationOnce(async () => { calls.push("archive"); });
    vi.mocked(rawExecFile).mockImplementationOnce(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        calls.push((args as string[]).join(" "));
        (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );

    await removeLocalContainer("a".repeat(64));

    expect(calls).toEqual(["archive", "rm -f " + "a".repeat(64)]);
    expect(archiveLocalContainerLogsBestEffortMock).toHaveBeenCalledWith("a".repeat(64));
  });

  it("still removes the container when best-effort archive reports failure internally", async () => {
    archiveLocalContainerLogsBestEffortMock.mockResolvedValueOnce(undefined);

    await removeLocalContainer("b".repeat(64));

    expect(rawExecFile).toHaveBeenCalledWith("docker", ["rm", "-f", "b".repeat(64)], expect.any(Function));
  });
});

describe("stopLocalContainer", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function mockExec(err: Error | null) {
    const calls: string[][] = [];
    vi.mocked(rawExecFile).mockImplementation(
      (_cmd: unknown, args: unknown, cb: unknown) => {
        calls.push(args as string[]);
        (cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void)(err, err ? undefined : { stdout: "", stderr: "" });
        return {} as ReturnType<typeof rawExecFile>;
      },
    );
    return calls;
  }

  it("force-removes the container without archiving logs", async () => {
    const calls = mockExec(null);
    await stopLocalContainer("c-1");
    expect(calls).toEqual([["rm", "-f", "c-1"]]);
    expect(archiveLocalContainerLogsBestEffortMock).not.toHaveBeenCalled();
  });

  it("counts a missing container as stopped", async () => {
    mockExec(Object.assign(new Error("failed"), { stderr: "Error response from daemon: No such container: c-1" }));
    await expect(stopLocalContainer("c-1")).resolves.toBeUndefined();
  });

  it("rejects on any other docker error", async () => {
    mockExec(Object.assign(new Error("failed"), { stderr: "Cannot connect to the Docker daemon" }));
    await expect(stopLocalContainer("c-1")).rejects.toThrow(/Cannot connect/);
  });
});
