import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalCredentialPort, LocalSessionOwnership } from "../local/agent-config.js";
import type { LocalCredentialReference } from "../local/agent-config.js";
import { startLocalAuthBridge } from "../local/session.js";
import { runDevHarnessCli } from "../dev-harness/cli.js";
import type { DevHarnessCliDependencies } from "../dev-harness/cli.js";
import type { DevRunHandle } from "../dev-harness/index.js";

// Real bridge, real ownership, real protected record in a temp dir; only Docker is faked.
let root: string;
let repo: string;
let outside: string;
let sessionPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cancel-release-"));
  await chmod(root, 0o700);
  repo = join(root, "repo");
  outside = join(root, "outside");
  await mkdir(repo);
  await mkdir(outside, { mode: 0o700 });
  await chmod(outside, 0o700);
  sessionPath = join(outside, "session.json");
  await writeFile(sessionPath, '{"synthetic":"session-0000"}', { mode: 0o600 });
  await chmod(sessionPath, 0o600);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reference = (): LocalCredentialReference => ({
  kind: "session",
  profileId: "sub-a",
  authMode: "claude-subscription",
  canonicalPath: sessionPath,
} as unknown as LocalCredentialReference);

async function lockFiles(): Promise<string[]> {
  return (await readdir(outside)).filter((n) => n.endsWith(".ai-lock"));
}

async function setup(io?: { afterVerifyOwner?: () => Promise<void> }) {
  const ownership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
  const lease = await ownership.acquire(reference());
  const port = createLocalCredentialPort({
    references: new Map([["sub-a", reference()]]),
    forbiddenRoots: [repo],
    ownership,
    ...(io ? { io } : {}),
  } as never);
  const bridge = await startLocalAuthBridge({
    snapshotId: "snap-1",
    projectKey: "owner/repo",
    credentialPort: port,
    ownership,
    leases: [lease],
    references: [],
    trustedRepositories: ["owner/repo"],
  });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${new URL(bridge.bootstrap.bridge.baseUrl).port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.bootstrap.bridge.bearer}` },
      body: JSON.stringify(body),
    });
  return { ownership, lease, port, bridge, post };
}

function cancelledDeps(
  bridge: Awaited<ReturnType<typeof startLocalAuthBridge>>,
  status: { running: boolean; exitCode: number | null },
) {
  const controller = new AbortController();
  const stderr: string[] = [];
  const collect = vi.fn(async () => undefined);
  const handle = {
    containerName: "c",
    containerId: "c".repeat(64),
    artifactsDir: "/tmp/a",
    workspace: "/tmp/w",
    startedAt: new Date(),
    task: { identifier: "T-1", title: "t" },
    phase: "implementation",
    localAuth: bridge,
  } as unknown as DevRunHandle;
  const deps: DevHarnessCliDependencies = {
    startDevRun: vi.fn().mockResolvedValue(handle),
    streamLogs: vi.fn(async () => { controller.abort(); }),
    streamLogsUntilShellReady: vi.fn(),
    getRunStatus: vi.fn().mockResolvedValue({ status: "exited", ...status }),
    collectRunArtifacts: collect,
    stopSession: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    spawnDocker: vi.fn(),
    writeStdout: vi.fn(),
    writeStderr: (t) => { stderr.push(t); },
    now: () => Date.now(),
    cancelSignal: controller.signal,
  };
  return { deps, stderr, collect };
}

const ARGS = ["--workspace", "/tmp/workspace", "--task", "/tmp/task.md"];

describe("cancellation release without a terminal disposition (real bridge + ownership)", () => {
  it("releases an unused lease once termination is confirmed and keeps 130 apart from the Docker exit", async () => {
    const { bridge, ownership } = await setup();
    expect(await lockFiles()).toHaveLength(1);
    const { deps, stderr, collect } = cancelledDeps(bridge, { running: false, exitCode: 0 });

    expect(await runDevHarnessCli(ARGS, deps)).toBe(130);

    expect(collect).toHaveBeenCalledWith(expect.anything(), 0, expect.any(Function));
    expect((collect.mock.calls[0] as unknown as [unknown, unknown, () => boolean])[2]()).toBe(true);
    expect(await lockFiles()).toEqual([]);
    expect(stderr.join("")).toContain("local session lease: released");
    await expect(ownership.acquire(reference())).resolves.toBeDefined();
  });

  it("holds a used lease and reports the category without token or path", async () => {
    const { bridge, post } = await setup();
    expect((await post("/load", { profileId: "sub-a", authMode: "claude-subscription" })).status).toBe(200);
    const lockName = (await lockFiles())[0]!;
    const before = await readFile(join(outside, lockName), "utf8");
    const token = (JSON.parse(before) as { token: string }).token;
    const { deps, stderr } = cancelledDeps(bridge, { running: false, exitCode: 0 });

    expect(await runDevHarnessCli(ARGS, deps)).toBe(130);

    expect(await readFile(join(outside, lockName), "utf8")).toBe(before);
    const text = stderr.join("");
    expect(text).toContain("local session lease: held (persistence_missing)");
    expect(text).not.toContain(token);
    expect(text).not.toContain(outside);
    expect(text).not.toContain(bridge.bootstrap.bridge.bearer);
  });

  it("holds when termination is unknown or the container is still running", async () => {
    for (const status of [{ running: true, exitCode: null }, { running: false, exitCode: null }]) {
      const { bridge } = await setup();
      const { deps, stderr, collect } = cancelledDeps(bridge, status);
      expect(await runDevHarnessCli(ARGS, deps)).toBe(130);
      expect(collect).toHaveBeenCalledWith(expect.anything(), status.exitCode, expect.any(Function));
      expect(stderr.join("")).toContain("held (termination_unconfirmed)");
      expect(await lockFiles()).toHaveLength(1);
      await rm(join(outside, (await lockFiles())[0]!));
    }
  });

  it("holds when the stored lock no longer matches the lease (stale owner)", async () => {
    const { bridge } = await setup();
    const lockName = (await lockFiles())[0]!;
    const record = JSON.parse(await readFile(join(outside, lockName), "utf8")) as { token: string };
    await writeFile(join(outside, lockName), JSON.stringify({ ...record, token: "x".repeat(48) }), { mode: 0o600 });
    const { deps, stderr } = cancelledDeps(bridge, { running: false, exitCode: 143 });

    expect(await runDevHarnessCli(ARGS, deps)).toBe(130);

    expect(await lockFiles()).toHaveLength(1);
    expect(stderr.join("")).toMatch(/lease: held \(/);
    expect(stderr.join("")).not.toContain("lease: released");
  });

  it("a checkout racing the close is never released from under the credentials", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const { bridge, post } = await setup({ afterVerifyOwner: async () => { entered(); await gate; } });
    const load = post("/load", { profileId: "sub-a", authMode: "claude-subscription" });
    await started;
    const closing = bridge.close();
    open();
    await closing;
    const response = await load;

    expect(response.status).toBe(200);
    await expect(bridge.releaseUnused(async () => "confirmed")).rejects.toBeInstanceOf(AggregateError);
    expect(await lockFiles()).toHaveLength(1);
  });

  it("a late safe disposition still takes the normal release path and not releaseUnused", async () => {
    const { bridge, post } = await setup();
    await post("/disposition", { safe: true });
    const unused = vi.spyOn(bridge, "releaseUnused");
    const { deps, stderr } = cancelledDeps(bridge, { running: false, exitCode: 0 });

    expect(await runDevHarnessCli(ARGS, deps)).toBe(130);

    expect(unused).not.toHaveBeenCalled();
    expect(await lockFiles()).toEqual([]);
    expect(stderr.join("")).toContain("lease: released");
  });
});
