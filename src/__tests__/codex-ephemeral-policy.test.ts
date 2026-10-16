/**
 * AII-1437: the ephemeral full-access policy through the real composition. The workflow's own bootstrap script
 * validates and projects the policy, `prepareConfiguredRun` re-checks it, and the real createStageExecutor ->
 * CodexExecutor -> ModelAuthClient chain builds argv. Only the `codex` child process (spawnImpl) and the
 * model-auth transport are doubles.
 */
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfiguredRunError, prepareConfiguredRun } from "../run-autonomous.js";
import { NOW, SENTINEL_BEARER, makeSnapshot } from "./configured-run-fixture.js";
import { S_AMBIENT, S_CHATGPT, S_OPENAI, codexLoopback } from "./codex-composition-fixture.js";
import { GHA_CONTEXT, GHA_IMPLEMENT_WORKFLOWS, GHA_POLICY, ghaGrant, ghaRunStepEnv } from "./gha-handoff-fixture.js";
import type { InvokeParams } from "../pipeline/types.js";

const FLAG = "--dangerously-bypass-approvals-and-sandbox";
const CANARIES = {
  GITHUB_TOKEN: "canary-github-token-AAAA1111",
  GH_TOKEN: "canary-gh-token-BBBB2222",
  RUN_TOKEN: "canary-run-token-CCCC3333",
  RUN_PROGRESS_TOKEN: "canary-progress-token-DDDD4444",
  RUN_PUBLICATION_TOKEN: "canary-publication-token-EEEE5555",
  AI_IMPLEMENT_FORWARDED_ENV: "canary-forwarded-FFFF6666",
  GIT_ASKPASS: "canary-askpass-GGGG7777",
};
const REMOTE_CANARY = "canary-remote-token-HHHH8888";
const admitted = () => ({ nonRoot: true, socketPresent: true, socketReadable: false, socketWritable: false, admitted: true });

const ev = (o: unknown): string => JSON.stringify(o);
const ok = [
  ev({ type: "thread.started", thread_id: "t1" }),
  ev({ type: "turn.started" }),
  ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } }),
  ev({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
];
const expired = [
  ev({ type: "thread.started", thread_id: "t1" }),
  ev({ type: "turn.started" }),
  ev({ type: "error", message: "unexpected status 401 Unauthorized: token expired" }),
];

interface Child { args: string[]; env: Record<string, string>; stdin: string; remote: string }
function scriptedSpawn(scripts: Array<{ stdout: string[]; exitCode: number }>, log: Child[], workspace: string): typeof spawn {
  return ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const script = scripts[Math.min(log.length, scripts.length - 1)];
    const rec: Child = { args, env: opts.env, stdin: "", remote: execFileSync("git", ["remote", "get-url", "origin"], { cwd: workspace }).toString().trim() };
    log.push(rec);
    const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => (rec.stdin += d.toString()));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(proc, { stdin, stdout, stderr, pid: undefined, kill: () => true, unref: () => {} });
    setImmediate(() => {
      for (const line of script.stdout) stdout.write(`${line}\n`);
      setImmediate(() => {
        stdout.end();
        stderr.end();
        proc.emit("close", script.exitCode, null);
      });
    });
    return proc;
  }) as unknown as typeof spawn;
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "policy-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["remote", "add", "origin", `https://x-access-token:${REMOTE_CANARY}@github.com/acme/app.git`], { cwd: workspace });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

type Opts = { policy?: unknown; context?: unknown; env?: Record<string, string>; authMode?: "codex-subscription" | "openai-api-key"; scripts?: Array<{ stdout: string[]; exitCode: number }>; admission?: () => ReturnType<typeof admitted> };

async function compose(file: string, o: Opts = {}) {
  const authMode = o.authMode ?? "codex-subscription";
  const snapshot = makeSnapshot(authMode);
  const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: o.context ?? GHA_CONTEXT, policy: o.policy, callback: false });
  expect(handoff.bootStatus).toBe(0);
  const env = { ...handoff.runEnv, ...(o.env ?? {}) };
  for (const [k, v] of Object.entries({ ...CANARIES, OPENAI_API_KEY: S_AMBIENT })) vi.stubEnv(k, v);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { transport, checkouts } = codexLoopback({ "p-plan": "anthropic-api-key", "p-impl": authMode, "p-rev": "anthropic-api-key" });
  const log: Child[] = [];
  const run = await prepareConfiguredRun({
    env: { ...process.env, ...env },
    workspaceDir: workspace,
    snapshot,
    options: {
      modelAuthTransport: transport,
      now: () => NOW,
      codexOptions: { spawnImpl: scriptedSpawn(o.scripts ?? [{ stdout: ok, exitCode: 0 }], log, workspace), sleepImpl: async () => {}, fullAccessAdmission: o.admission ?? admitted },
    },
  });
  const executor = run!.createExecutor({ workspaceDir: workspace, logLevel: "summary" });
  const invoke = (agentStage: InvokeParams["agentStage"]) => executor.invoke({ prompt: "edit the file", model: "ignored", stage: "implement", agentStage });
  return { run: run!, invoke, log, checkouts, handoff };
}

for (const file of GHA_IMPLEMENT_WORKFLOWS) {
  describe(`ephemeral full access via ${file}`, () => {
    it("the workflow projects the policy only when the credentials carry it", () => {
      const snapshot = makeSnapshot();
      const withPolicy = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, policy: GHA_POLICY, callback: false });
      expect(withPolicy.runEnv.AI_IMPLEMENT_EXECUTION_POLICY).toBe("v1:ephemeral-full-access:gha:disp-1:proj");
      const without = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, callback: false });
      expect(without.runEnv.AI_IMPLEMENT_EXECUTION_POLICY).toBe("");
    });

    const badPolicies: Array<[string, unknown]> = [
      ["false assertion", { ...GHA_POLICY, ephemeralRunnerAsserted: false }],
      ["wrong version", { ...GHA_POLICY, version: 2 }],
      ["unknown field", { ...GHA_POLICY, extra: true }],
      ["wrong backend", { ...GHA_POLICY, backend: "fly" }],
      ["mismatched dispatch", { ...GHA_POLICY, dispatchId: "other" }],
      ["mismatched project", { ...GHA_POLICY, projectKey: "other" }],
      ["unsupported sandbox", { ...GHA_POLICY, implementationSandbox: "danger-full-access" }],
      ["not an object", "ephemeral-full-access"],
    ];
    for (const [name, policy] of badPolicies) {
      it(`bootstrap rejects a ${name} before any Run step env exists`, () => {
        const snapshot = makeSnapshot();
        const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, policy, callback: false });
        expect(handoff.bootStatus).not.toBe(0);
        expect(handoff.runEnv).toEqual({});
      });
    }

    it("bootstrap rejects a policy with no model-auth context", () => {
      const snapshot = makeSnapshot();
      const handoff = ghaRunStepEnv(file, { snapshot, policy: GHA_POLICY, callback: false });
      expect(handoff.bootStatus).not.toBe(0);
    });

    it("implementation gets the bypass flag; planning never does; review stays read-only", async () => {
      const { invoke, log, checkouts } = await compose(file, { policy: GHA_POLICY });
      await invoke("implementation");
      expect(log[0].args).toContain(FLAG);
      expect(log[0].args).not.toContain("--sandbox");
      expect(checkouts).toEqual([{ profileId: "p-impl", authMode: "codex-subscription" }]);
      // Selected auth, model and profile are unchanged by the policy.
      expect(log[0].args).toContain("gpt-impl");
      expect(log[0].env.CHATGPT_PLAN_ACCESS_TOKEN).toBe(S_CHATGPT);
    });

    it("review on a Claude-selected stage never reaches the Codex bypass path", async () => {
      const { run } = await compose(file, { policy: GHA_POLICY });
      const claude = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, tokensUsed: 0 }));
      const executor = run.createExecutor({ workspaceDir: workspace, legacy: { invoke: claude } as never, logLevel: "summary" });
      await executor.invoke({ prompt: "p", model: "m", stage: "review", agentStage: "review" });
      expect(claude).toHaveBeenCalledTimes(1);
    });

    it("default: no policy keeps workspace-write and no admission probe runs", async () => {
      const probe = vi.fn(admitted);
      const { invoke, log } = await compose(file, { admission: probe });
      await invoke("implementation");
      expect(log[0].args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
      expect(log[0].args).not.toContain(FLAG);
      expect(probe).not.toHaveBeenCalled();
    });

    it("a token-expiry resume pins the same full-access authority", async () => {
      const { invoke, log } = await compose(file, { policy: GHA_POLICY, scripts: [{ stdout: expired, exitCode: 1 }, { stdout: ok, exitCode: 0 }] });
      await invoke("implementation");
      expect(log).toHaveLength(2);
      expect(log[1].args.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(log[0].args).toContain(FLAG);
      expect(log[1].args).toContain(FLAG);
      expect(log[1].args).toContain("gpt-impl");
    });

    it("the API-key profile also gets the flag, with only the selected key in the child env", async () => {
      const { invoke, log } = await compose(file, { policy: GHA_POLICY, authMode: "openai-api-key" });
      await invoke("implementation");
      expect(log[0].args).toContain(FLAG);
      expect(log[0].env.CODEX_API_KEY).toBe(S_OPENAI);
    });

    it("keeps publication, Git, bootstrap and callback credentials out of the child and removes the tokenized remote", async () => {
      const { invoke, log, handoff } = await compose(file, { policy: GHA_POLICY });
      await invoke("implementation");
      const child = log[0];
      const surface = JSON.stringify({ args: child.args, env: child.env, stdin: child.stdin, remote: child.remote });
      for (const canary of [...Object.values(CANARIES), REMOTE_CANARY, S_AMBIENT, SENTINEL_BEARER, handoff.runEnv.AI_IMPLEMENT_RUN_CONFIG]) {
        expect(surface).not.toContain(canary);
      }
      expect(Object.keys(child.env).filter((k) => k.startsWith("AI_IMPLEMENT_") || k.startsWith("RUN_") || k.startsWith("GIT_") || k.includes("GITHUB") || k === "GH_TOKEN")).toEqual([]);
      expect(child.remote).toBe("https://github.com/acme/app.git");
      // Restored afterwards for the pipeline's own publication step.
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: workspace }).toString()).toContain(REMOTE_CANARY);
    });

    it("refuses before any checkout or spawn when admission fails", async () => {
      const { invoke, log, checkouts } = await compose(file, {
        policy: GHA_POLICY,
        admission: () => ({ nonRoot: true, socketPresent: true, socketReadable: true, socketWritable: true, admitted: false }),
      });
      await expect(invoke("implementation")).rejects.toMatchObject({ code: "CODEX_FULL_ACCESS_REFUSED" });
      expect(log).toHaveLength(0);
      expect(checkouts).toEqual([]);
    });

    describe("spoof cases never enable full access", () => {
      it("an ambient launch flag without the envelope policy is rejected", async () => {
        await expect(compose(file, { env: { AI_IMPLEMENT_EXECUTION_POLICY: "v1:ephemeral-full-access:gha:disp-1:proj" } })).rejects.toMatchObject({ reason: "execution_policy_invalid" });
      });
      it("an envelope policy without the launch variable stays default", async () => {
        const { invoke, log } = await compose(file, { policy: GHA_POLICY, env: { AI_IMPLEMENT_EXECUTION_POLICY: "" } });
        await invoke("implementation");
        expect(log[0].args).not.toContain(FLAG);
        expect(log[0].args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
      });
      it("a launch variable for another dispatch or project is rejected", async () => {
        for (const value of ["v1:ephemeral-full-access:gha:other:proj", "v1:ephemeral-full-access:gha:disp-1:other", "v1:ephemeral-full-access:fly:disp-1:proj", "true", "1"]) {
          await expect(compose(file, { policy: GHA_POLICY, env: { AI_IMPLEMENT_EXECUTION_POLICY: value } })).rejects.toBeInstanceOf(ConfiguredRunError);
        }
      });
      it("GITHUB_ACTIONS alone and a diagnostic stage string are not authority", async () => {
        const { invoke, log } = await compose(file, { env: { GITHUB_ACTIONS: "true", CI: "true" } });
        await invoke("implementation");
        expect(log[0].args).not.toContain(FLAG);
      });
    });
  });
}

describe("planning workflow", () => {
  it("rejects a credentials namespace carrying the policy: planning can never be granted it", async () => {
    const { GHA_PLAN_WORKFLOWS } = await import("./gha-handoff-fixture.js");
    for (const file of GHA_PLAN_WORKFLOWS) {
      const snapshot = makeSnapshot();
      const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, policy: GHA_POLICY, callback: false });
      expect(handoff.bootStatus).not.toBe(0);
    }
  });
});
