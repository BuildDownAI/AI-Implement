import { execFile as rawExecFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveLocalContainerLogsBestEffortMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../local-job-logs.js", () => ({
  archiveLocalContainerLogsBestEffort: archiveLocalContainerLogsBestEffortMock,
}));

import { removeLocalContainer } from "../local-docker.js";

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
