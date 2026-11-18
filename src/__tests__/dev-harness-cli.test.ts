import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDevHarnessCli } from "../dev-harness/cli.js";
import type { DevRunHandle } from "../dev-harness/index.js";
import { makeDevHarnessCliDeps, makeDevRunHandle, makeTaskFile } from "./helpers/fixtures/dev-harness.js";

/** The `--workspace` every run passes: the one the fixture's handle reports, as startDevRun's handle reports its own. */
const WORKSPACE = makeDevRunHandle().workspace;

/** The handle startDevRun returns for `--phase kg-refresh`: its built-in task, no workspace mode. */
const KG_REFRESH_HANDLE = makeDevRunHandle({
  task: makeTaskFile({ identifier: "KG-DEV", title: "KG refresh (local dev)", description: "Local dev kg-refresh run" }),
  phase: "kg-refresh",
  workspaceMode: undefined,
});

/** The handle a configured run (`--phase full --agent-config`) returns: its local auth bridge, whose calls land in
 *  `events`, and the cleanup for its bootstrap directory, which startDevRun always pairs with the bridge. */
function makeHandleWithLocalAuth(events: string[], overrides: Partial<DevRunHandle> = {}): DevRunHandle {
  return makeDevRunHandle({
    phase: "full",
    localAuth: {
      bootstrap: {
        version: 1,
        snapshotId: "snap-1",
        projectKey: "owner/repo",
        bridge: { baseUrl: "http://host.docker.internal:1234", bearer: "b".repeat(40) },
        references: [],
        trustedRepositories: ["owner/repo"],
      },
      safeDisposition: true,
      close: vi.fn(async () => { events.push("close"); }),
      releaseAfterTermination: vi.fn(async (confirm) => { events.push(`release:${await confirm()}`); }),
      releaseUnused: vi.fn(),
    },
    sourceWorkspaceCleanup: vi.fn(async () => undefined),
    ...overrides,
  });
}

const CONFIGURED_RUN = ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "full", "--agent-config", "agent-config.json"];

describe("runDevHarnessCli", () => {
  it("passes planning phase through the public CLI", async () => {
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => makeDevRunHandle({ phase: "planning" })) });

    await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "planning"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "planning" }));
  });

  it("passes the full planning-to-implementation loop through the public CLI", async () => {
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => makeDevRunHandle({ phase: "full" })) });

    await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "full"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "full" }));
  });

  it("passes local configured-run flags through the public CLI", async () => {
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => makeHandleWithLocalAuth([], { workspaceMode: "copy" })) });

    await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "full", "--workspace-mode", "copy", "--agent-config", "agent-config.json"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({
      phase: "full",
      workspaceMode: "copy",
      agentConfig: resolve("agent-config.json"),
    }));
  });

  it("rejects explicit --agent-config without a value before starting", async () => {
    const deps = makeDevHarnessCliDeps();

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "full", "--agent-config"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.startDevRun).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("--agent-config"));
  });

  it("does not require --tracker-data for --phase kg-refresh at the CLI-parsing layer (AII-608)", async () => {
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => KG_REFRESH_HANDLE) });

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--phase", "kg-refresh"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.startDevRun).toHaveBeenCalledWith(expect.objectContaining({ phase: "kg-refresh", trackerData: undefined }));
  });

  it("resolves --tracker-data to an absolute path when given, and passes it through unchanged regardless of orchestrator env", async () => {
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => KG_REFRESH_HANDLE) });

    await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--phase", "kg-refresh", "--tracker-data", "td.json"],
      deps,
    );

    expect(deps.startDevRun).toHaveBeenCalledWith(
      expect.objectContaining({ trackerData: resolve("td.json") }),
    );
  });

  it("surfaces a startDevRun rejection (e.g. no tracker data source available) as exit 1 with a stderr message naming both options, rather than an unhandled rejection", async () => {
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => {
        throw new Error(
          "kg-refresh needs tracker data: pass --tracker-data <file>, or set ORCHESTRATOR_URL plus " +
          "ADMIN_ACCESS_CODE or AI_IMPLEMENT_ADMIN_TOKEN in the operator's env so the harness can fetch it.",
        );
      }),
    });

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--phase", "kg-refresh"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("--tracker-data"));
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("ORCHESTRATOR_URL"));
  });

  it("rejects an unknown phase before starting Docker", async () => {
    const deps = makeDevHarnessCliDeps();

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "other"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.startDevRun).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("kg-refresh"));
  });

  it.each([
    ["--until", "setup"],
    ["--shell"],
  ])("rejects implementation-only option %s for a full-loop run", async (...extraArgs: string[]) => {
    const deps = makeDevHarnessCliDeps();

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--phase", "full", ...extraArgs],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(deps.startDevRun).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("only supported for --phase implementation"));
  });

  it("collects shell-mode artifacts before removing the container", async () => {
    const events: string[] = [];
    const deps = makeDevHarnessCliDeps({
      streamLogsUntilShellReady: vi.fn(async () => ({ ready: true, exitCode: 0 })),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      spawnDocker: vi.fn(() => { events.push("shell"); return 0; }),
    });

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual(["shell", "artifacts", "remove"]);
  });

  it("returns the docker exec failure after collecting artifacts and removing the container", async () => {
    const events: string[] = [];
    const deps = makeDevHarnessCliDeps({
      streamLogsUntilShellReady: vi.fn(async () => ({ ready: true, exitCode: 0 })),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      spawnDocker: vi.fn(() => { events.push("shell"); return 125; }),
    });

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(125);
    expect(events).toEqual(["shell", "artifacts", "remove"]);
  });

  it("uses stopSession for teardown and not direct docker rm", async () => {
    const handle = makeDevRunHandle();
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => handle),
      streamLogsUntilShellReady: vi.fn(async () => ({ ready: true, exitCode: 0 })),
    });

    await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(deps.stopSession).toHaveBeenCalledWith(expect.objectContaining({ containerId: handle.containerId }));
    const spawnDockerCalls = vi.mocked(deps.spawnDocker).mock.calls;
    expect(spawnDockerCalls.every(([args]) => args[0] !== "rm")).toBe(true);
  });

  it("continues normally when stopSession rejects", async () => {
    const deps = makeDevHarnessCliDeps({
      streamLogsUntilShellReady: vi.fn(async () => ({ ready: true, exitCode: 0 })),
      stopSession: vi.fn(async () => { throw new Error("docker daemon unreachable"); }),
    });

    const exitCode = await runDevHarnessCli(
      ["--workspace", WORKSPACE, "--task", "/tmp/task.md", "--shell"],
      deps,
    );

    expect(exitCode).toBe(0);
  });

  it("closes and drains local auth before releasing with a confirmed stopped status", async () => {
    const events: string[] = [];
    const handle = makeHandleWithLocalAuth(events);
    const deps = makeDevHarnessCliDeps({ startDevRun: vi.fn(async () => handle) });

    const exitCode = await runDevHarnessCli(CONFIGURED_RUN, deps);

    expect(exitCode).toBe(0);
    expect(events).toEqual(["close", "release:confirmed"]);
  });

  it("holds local auth release when terminal status is ambiguous even if running is false", async () => {
    const events: string[] = [];
    const handle = makeHandleWithLocalAuth(events);
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => handle),
      getRunStatus: vi.fn(async () => ({ status: "unknown" as const, running: false, exitCode: null })),
    });

    const exitCode = await runDevHarnessCli(CONFIGURED_RUN, deps);

    expect(exitCode).toBe(1);
    expect(events).toEqual(["close", "release:unknown"]);
  });

  it("finalizes local auth and temp cleanup when artifact collection fails", async () => {
    const events: string[] = [];
    const handle = makeHandleWithLocalAuth(events, { sourceWorkspaceCleanup: vi.fn(async () => { events.push("temp-cleanup"); }) });
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => handle),
      collectRunArtifacts: vi.fn(async () => { throw new Error("artifact failed"); }),
    });

    await expect(runDevHarnessCli(CONFIGURED_RUN, deps)).rejects.toThrow("artifact failed");

    expect(events).toEqual(["close", "release:confirmed", "temp-cleanup"]);
  });

  it("stops the container on cancellation, collects artifacts before removal, then finalizes", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const handle = makeHandleWithLocalAuth(events);
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => handle),
      streamLogs: vi.fn(async () => { events.push("logs"); controller.abort(); }),
      getRunStatus: vi.fn(async () => ({ status: "exited" as const, running: false, exitCode: 143 })),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      stopContainer: vi.fn(async () => { events.push("stop"); }),
      cancelSignal: controller.signal,
    });

    const exitCode = await runDevHarnessCli(CONFIGURED_RUN, deps);

    expect(exitCode).toBe(130);
    expect(events).toEqual(["logs", "stop", "artifacts", "close", "release:confirmed", "remove"]);
  });

  it("does not hang when cancellation stop fails and logs never finish", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];
    const handle = makeHandleWithLocalAuth(events);
    const deps = makeDevHarnessCliDeps({
      startDevRun: vi.fn(async () => handle),
      streamLogs: vi.fn(() => new Promise<void>(() => undefined)),
      getRunStatus: vi.fn(async () => ({ status: "running" as const, running: true, exitCode: null })),
      collectRunArtifacts: vi.fn(async () => { events.push("artifacts"); }),
      stopSession: vi.fn(async () => { events.push("remove"); }),
      stopContainer: vi.fn(async () => { events.push("stop"); throw new Error("stop failed"); }),
      cancelSignal: controller.signal,
    });

    const exitCode = await runDevHarnessCli(CONFIGURED_RUN, deps);

    expect(exitCode).toBe(130);
    expect(events).toEqual(["stop", "artifacts", "close", "release:unknown", "remove"]);
  });
});
