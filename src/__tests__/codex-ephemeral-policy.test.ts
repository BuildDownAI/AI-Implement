/**
 * AII-1437: the ephemeral full-access policy through the real composition. The workflow's own bootstrap script
 * validates and projects the policy, `prepareConfiguredRun` re-checks it, and the real createStageExecutor ->
 * CodexExecutor -> ModelAuthClient chain builds argv. Only the `codex` child process (spawnImpl) and the
 * model-auth transport are doubles.
 */
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfiguredRunError, prepareConfiguredRun } from "../run-autonomous.js";
import { NOW, SENTINEL_BEARER, makeSnapshot } from "./helpers/fixtures/configured-run.js";
import { S_AMBIENT, S_CHATGPT, S_OPENAI, codexLoopback } from "./helpers/fixtures/codex-composition.js";
import { MODEL_AUTH_ROUTES } from "../model-auth-contract.js";
import { GHA_CONTEXT, GHA_IMPLEMENT_WORKFLOWS, GHA_POLICY, ghaGrant, ghaRunStepEnv } from "./helpers/fixtures/gha-handoff.js";
import type { InvokeParams } from "../pipeline/types.js";
import { makeExecutor } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

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
function scriptedSpawn(scripts: Array<{ stdout: string[]; exitCode: number; hang?: boolean }>, log: Child[], workspace: string): typeof spawn {
  return ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const script = scripts[Math.min(log.length, scripts.length - 1)];
    const rec: Child = { args, env: opts.env, stdin: "", remote: execFileSync("git", ["remote", "get-url", "origin"], { cwd: workspace }).toString().trim() };
    log.push(rec);
    const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => (rec.stdin += d.toString()));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closeWith = (code: number | null, sig: NodeJS.Signals | null): void => {
      stdout.end();
      stderr.end();
      proc.emit("close", code, sig);
    };
    Object.assign(proc, {
      stdin, stdout, stderr, pid: undefined, unref: () => {},
      kill: (sig: NodeJS.Signals) => {
        if (script.hang) setImmediate(() => closeWith(null, sig));
        return true;
      },
    });
    if (script.hang) return proc;
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
  workspace = testDir("policy-ws");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["remote", "add", "origin", `https://x-access-token:${REMOTE_CANARY}@github.com/acme/app.git`], { cwd: workspace });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
      expect(ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT,
        callback: false, runnerEnvironment: "self-hosted" }).bootStatus).toBe(0);
    });

    it.each(["self-hosted", "", "unknown", null])("rejects full access on runner environment %s", (runnerEnvironment) => {
      const snapshot = makeSnapshot();
      const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT,
        policy: GHA_POLICY, callback: false, runnerEnvironment });
      expect(handoff.bootStatus).not.toBe(0);
      expect(handoff.runEnv).toEqual({});
      expect(handoff.bootStderr).toContain("github-hosted");
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
      const claude = makeExecutor();
      const executor = run.createExecutor({ workspaceDir: workspace, legacy: claude, logLevel: "summary" });
      await executor.invoke({ prompt: "p", model: "m", stage: "review", agentStage: "review" });
      expect(claude.invoke).toHaveBeenCalledTimes(1);
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

    it("logs only the five safe admission booleans on success", async () => {
      const canary = "canary-report-extra-IIII9999";
      const logSpy = vi.mocked(console.log);
      const { invoke } = await compose(file, {
        policy: GHA_POLICY,
        admission: () => ({ ...admitted(), uid: 4242, groups: [canary], socketPath: `/${canary}` }) as ReturnType<typeof admitted>,
      });
      await invoke("implementation");
      const lines = logSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("full access"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(JSON.stringify(admitted()));
      expect(lines[0]).not.toContain(canary);
      expect(lines[0]).not.toContain("4242");
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
      it("an envelope policy with a blank launch variable is rejected, never downgraded to the sandbox", async () => {
        await expect(compose(file, { policy: GHA_POLICY, env: { AI_IMPLEMENT_EXECUTION_POLICY: "" } })).rejects.toMatchObject({ reason: "execution_policy_invalid" });
        await expect(compose(file, { policy: GHA_POLICY, env: { AI_IMPLEMENT_EXECUTION_POLICY: "   " } })).rejects.toMatchObject({ reason: "execution_policy_invalid" });
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
    const { GHA_PLAN_WORKFLOWS } = await import("./helpers/fixtures/gha-handoff.js");
    for (const file of GHA_PLAN_WORKFLOWS) {
      const snapshot = makeSnapshot();
      const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, policy: GHA_POLICY, callback: false });
      expect(handoff.bootStatus).not.toBe(0);
    }
  });
});

/** All three stages Codex-selected: planning and review (app-server), implementation (exec) through the real chain. */
describe("Codex-selected planning and review with the policy present", () => {
  const file = GHA_IMPLEMENT_WORKFLOWS[0];
  const codexSnapshot = (shared: boolean, authMode: "openai-api-key" | "codex-subscription") => {
    const snapshot = makeSnapshot(authMode);
    for (const stage of ["planning", "review"] as const) {
      const id = shared ? "p-impl" : stage === "planning" ? "p-plan" : "p-rev";
      snapshot.stages[stage] = { ...snapshot.stages[stage], agent: "codex", provider: "openai", model: `gpt-${stage}`, accountProfileId: id };
      snapshot.profiles[stage] = { ...snapshot.profiles[stage], id, agent: "codex", provider: "openai", authMode };
    }
    return snapshot;
  };

  async function composeCodex(shared: boolean, scripts: Array<{ stdout: string[]; exitCode: number; hang?: boolean }>, authMode: "openai-api-key" | "codex-subscription" = "openai-api-key", policy: unknown = GHA_POLICY, appServerChild?: (log: Child[]) => typeof spawn) {
    const snapshot = codexSnapshot(shared, authMode);
    const handoff = ghaRunStepEnv(file, { snapshot, grant: ghaGrant(snapshot), context: GHA_CONTEXT, policy, callback: false });
    expect(handoff.bootStatus).toBe(0);
    for (const [k, v] of Object.entries(handoff.runEnv)) vi.stubEnv(k, v);
    const profiles = Object.fromEntries(Object.values(snapshot.profiles).map((p) => [p.id, authMode]));
    const { transport, checkouts, routes } = codexLoopback(profiles);
    const log: Child[] = [];
    const driverInputs: unknown[] = [];
    const currentPolicy: { value: "planning" | "review" } = { value: "planning" };
    let expireReviewOnce = false;
    const run = await prepareConfiguredRun({
      env: { ...process.env, ...handoff.runEnv },
      workspaceDir: workspace,
      snapshot,
      options: {
        modelAuthTransport: transport,
        now: () => NOW,
        codexOptions: {
          spawnImpl: appServerChild ? appServerChild(log) : scriptedSpawn(scripts, log, workspace),
          sleepImpl: async () => {},
          termWaitMs: 20,
          killWaitMs: 20,
          fullAccessAdmission: admitted,
          trustedSkillsDir: join(workspace, "skills"),
          // With an app-server child double, the real default drivers are used: only the child's stdio is faked.
          protocolDriver: appServerChild ? undefined : {
            // The driver's policy follows the stage under test; the real selector only honours a matching policy.
            get policy() {
              return currentPolicy.value;
            },
            async run(input: { workspaceDir: string }) {
              driverInputs.push(input);
              if (currentPolicy.value === "review" && expireReviewOnce) {
                expireReviewOnce = false;
                return {
                  result: { stdout: "", stderr: "codex app-server transport: turn_failed", exitCode: 1, tokensUsed: 0, terminalStatus: { subtype: "error", isError: true }, signal: null },
                  sawUnsafe: false,
                  stopReason: null,
                  threadId: "t-review",
                  tokenExpired: true,
                };
              }
              return {
                result: { stdout: "done", stderr: "", exitCode: 0, tokensUsed: 1, ...(currentPolicy.value === "review" ? { structuredOutput: { approved: true, issues: [] } } : {}), terminalStatus: { subtype: "success", isError: false }, signal: null },
                sawUnsafe: false,
                stopReason: null,
                threadId: "t1",
              };
            },
          } as never,
        },
      },
    });
    const executor = run!.createExecutor({ workspaceDir: workspace, logLevel: "summary" });
    const invoke = (agentStage: InvokeParams["agentStage"], extra: Partial<InvokeParams> = {}) => {
      if (agentStage === "planning" || agentStage === "review") currentPolicy.value = agentStage;
      return executor.invoke({ prompt: "p", model: "ignored", stage: String(agentStage), agentStage, ...extra });
    };
    return { invoke, log, checkouts, routes, finish: () => run!.finish("completed"), driverInputs, expireReviewOnce: () => (expireReviewOnce = true) };
  }

  const BYPASS_TOKENS = [FLAG, "danger-full-access", "--dangerously"];
  const planningSpawn = { stdout: [], exitCode: 0, hang: true };

  for (const shared of [false, true]) {
    it(`planning uses the read-only app-server argv and review stays read-only (${shared ? "shared" : "separate"} profile)`, async () => {
      const { invoke, log, checkouts } = await composeCodex(shared, [planningSpawn, planningSpawn, { stdout: ok, exitCode: 0 }]);
      await invoke("planning");
      const reviewed = await invoke("review");
      // The exact structured verdict the review steps consume survives the real composition.
      expect(reviewed.structuredOutput).toEqual({ approved: true, issues: [] });
      expect(reviewed.attribution).toMatchObject({ agent: "codex", model: "gpt-review" });
      await invoke("implementation");
      expect(log).toHaveLength(3);
      const [plan, review, impl] = log;
      expect(plan.args[0]).toBe("app-server");
      expect(plan.args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', "features.shell_tool=false", "features.unified_exec=false"]));
      expect(plan.args).toContain('model="gpt-planning"');
      for (const t of BYPASS_TOKENS) expect(plan.args.join(" ")).not.toContain(t);
      // Review is on the restricted native transport too (AII-1438): never `exec`, never a bypass.
      expect(review.args[0]).toBe("app-server");
      expect(review.args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', "features.shell_tool=false", "features.unified_exec=false", 'model="gpt-review"']));
      expect(review.args).not.toContain("--sandbox");
      for (const t of BYPASS_TOKENS) expect(review.args.join(" ")).not.toContain(t);
      expect(impl.args).toContain(FLAG);
      expect(impl.args).not.toContain("--sandbox");
      expect(impl.args).toContain("gpt-implementation".replace("implementation", "impl"));
      // Selected profile per stage, with only that profile's key in each child env.
      for (const c of log) expect(c.env.CODEX_API_KEY).toBe(S_OPENAI);
      expect(new Set(checkouts.map((c) => c.profileId)).size).toBe(shared ? 1 : 3);
    });
  }

  it("a review resume after token expiry stays on the restricted app-server, no bypass, while implementation resume keeps the bypass", async () => {
    const { invoke, log, driverInputs, expireReviewOnce } = await composeCodex(false, [
      planningSpawn, planningSpawn,
      { stdout: expired, exitCode: 1 }, { stdout: ok, exitCode: 0 },
    ], "codex-subscription");
    expireReviewOnce();
    await invoke("review");
    await invoke("implementation");
    expect(log).toHaveLength(4);
    for (const c of [log[0], log[1]]) {
      expect(c.args[0]).toBe("app-server");
      expect(c.args).toContain('sandbox_mode="read-only"');
      for (const t of BYPASS_TOKENS) expect(c.args.join(" ")).not.toContain(t);
    }
    // The second review attempt resumes the saved thread through the same driver, not through `exec resume`.
    expect((driverInputs[1] as { resumeThreadId?: string }).resumeThreadId).toBe("t-review");
    expect(log[2].args).toContain(FLAG);
    expect(log[3].args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(log[3].args).toContain(FLAG);
  });

  // The default real createCodexReviewDriver is used; only the child's stdio (the protocol and provider side) is scripted.
  describe("real review driver through the real chain (child stdio faked)", () => {
    type Frame = Record<string, unknown>;
    const verdict = JSON.stringify({ approved: true, issues: [] });

    /** Scripts a `codex app-server` child. `onFrame` answers each client frame; a bare `kill` closes the child. */
    function appServer(onFrame: (spawnIndex: number, m: Frame, send: (f: Frame) => void) => void) {
      return (log: Child[]): typeof spawn =>
        ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
          const index = log.length;
          const rec: Child & { frames: Frame[] } = { args, env: opts.env, stdin: "", remote: "", frames: [] };
          log.push(rec);
          const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          const send = (f: Frame): void => void stdout.write(`${JSON.stringify(f)}\n`);
          let buf = "";
          stdin.on("data", (d: Buffer) => {
            rec.stdin += d.toString();
            buf += d.toString();
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const m = JSON.parse(buf.slice(0, nl)) as Frame;
              buf = buf.slice(nl + 1);
              rec.frames.push(m);
              setImmediate(() => onFrame(index, m, send));
            }
          });
          Object.assign(proc, {
            stdin, stdout, stderr, pid: undefined, unref: () => {},
            kill: (sig: NodeJS.Signals) => {
              setImmediate(() => {
                stdout.end();
                stderr.end();
                proc.emit("close", null, sig);
              });
              return true;
            },
          });
          return proc;
        }) as unknown as typeof spawn;
    }

    const bound = (p: Frame = {}): Frame => ({ threadId: "th-review", turnId: "tu1", ...p });
    // Handshake + a read/search/verdict turn; `expire` ends the turn with an HTTP 401 instead.
    const reviewTurn = (expire: boolean) => (_i: number, m: Frame, send: (f: Frame) => void): void => {
      if (m.method === "initialize") send({ id: m.id, result: { userAgent: "x" } });
      else if (m.method === "thread/start" || m.method === "thread/resume") send({ id: m.id, result: { thread: { id: "th-review" } } });
      else if (m.method === "turn/start") {
        send({ id: m.id, result: { turn: { id: "tu1" } } });
        if (expire) send({ method: "turn/completed", params: { threadId: "th-review", turn: { id: "tu1", status: "failed", error: { message: "unauthorized", httpStatusCode: 401 } } } });
        else send({ id: 100, method: "item/tool/call", params: bound({ callId: "c100", tool: "repo_read", arguments: { path: "sample.txt" } }) });
      } else if (m.id === 100) {
        send({ id: 101, method: "item/tool/call", params: bound({ callId: "c101", tool: "repo_search", arguments: { pattern: "needle" } }) });
      } else if (m.id === 101) {
        send({ method: "item/completed", params: bound({ item: { type: "agentMessage", id: "m", text: verdict } }) });
        send({ method: "turn/completed", params: { threadId: "th-review", turn: { id: "tu1", status: "completed" } } });
      }
    };

    for (const shared of [false, true]) {
      it(`reaches the real review policy: two tools, read-only thread, exact verdict, no bypass (${shared ? "shared" : "separate"} profile)`, async () => {
        writeFileSync(join(workspace, "sample.txt"), "alpha\nneedle here\n");
        const { invoke, log, checkouts, routes } = await composeCodex(shared, [], "openai-api-key", GHA_POLICY, appServer(reviewTurn(false)));
        const reviewed = await invoke("review");
        expect(reviewed.failure).toBeUndefined();
        expect(reviewed.structuredOutput).toEqual({ approved: true, issues: [] });
        expect(reviewed.attribution).toMatchObject({ agent: "codex", model: "gpt-review" });
        const child = log[0] as Child & { frames: Array<Record<string, unknown>> };
        expect(child.args[0]).toBe("app-server");
        expect(child.args).toContain("agents.enabled=false");
        expect(child.args).toContain('model="gpt-review"');
        for (const t of BYPASS_TOKENS) expect(child.args.join(" ")).not.toContain(t);
        const thread = child.frames.find((f) => f.method === "thread/start")!.params as { dynamicTools: Array<{ name: string }>; sandbox: string };
        expect(thread.dynamicTools.map((t) => t.name)).toEqual(["repo_read", "repo_search"]);
        expect(thread.sandbox).toBe("read-only");
        // Both host tools were answered by the real handlers: the search result is the search call's own output.
        const answers = child.frames.filter((f) => f.id === 100 || f.id === 101).map((f) => JSON.stringify(f.result));
        expect(answers[0]).toContain("needle here");
        expect(answers[1]).toContain("sample.txt:2: needle here");
        expect(child.env.CODEX_API_KEY).toBe(S_OPENAI);
        expect(checkouts.map((c) => c.profileId)).toEqual([shared ? "p-impl" : "p-rev"]);
        expect(routes()).toEqual([MODEL_AUTH_ROUTES.checkout]);
      });
    }

    it("a token expiry resumes the saved review thread through the real driver, still read-only with no bypass", async () => {
      writeFileSync(join(workspace, "sample.txt"), "alpha\nneedle here\n");
      const turns = [reviewTurn(true), reviewTurn(false)];
      const { invoke, log, routes, finish } = await composeCodex(false, [], "codex-subscription", GHA_POLICY, appServer((i, m, send) => turns[Math.min(i, 1)](i, m, send)));
      const reviewed = await invoke("review");
      expect(reviewed.failure).toBeUndefined();
      expect(reviewed.structuredOutput).toEqual({ approved: true, issues: [] });
      expect(log).toHaveLength(2);
      await finish();
      // The selected profile is checked out once for the expired and resumed attempts, then finished by the run.
      // No checkpoint is recorded because the synthetic child never refreshes the credential.
      expect(routes()).toEqual([MODEL_AUTH_ROUTES.checkout, MODEL_AUTH_ROUTES.finish]);
      const resumed = (log[1] as Child & { frames: Array<Record<string, unknown>> }).frames.find((f) => f.method === "thread/resume")!.params as { threadId: string; sandbox: string };
      expect(resumed.threadId).toBe("th-review");
      expect(resumed.sandbox).toBe("read-only");
      for (const c of log) {
        expect(c.args[0]).toBe("app-server");
        for (const t of BYPASS_TOKENS) expect(c.args.join(" ")).not.toContain(t);
      }
    });
  });
});
