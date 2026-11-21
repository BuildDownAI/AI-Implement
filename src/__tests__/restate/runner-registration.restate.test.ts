// Restate scenarios for the bounded runner registration helper (AII-2066,
// `src/restate/runner-registration.ts`). A fixture workflow calls the helper with
// in-process fakes for the URI, container state and register function, and the slow-start
// case registers a real HTTP/2 endpoint after a gate. Every scenario runs under both
// variants; waits use gates, `eventually` and durable sleeps, never a fixed test sleep.
//
// Run with `npm run test:restate` (binary runtime, no Docker); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type { WorkflowContext } from "@restatedev/restate-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BackendRunState } from "../../backend-run.js";
import { registerRunnerDeployment, removeDeployment } from "../../restate/endpoint.js";
import type { RegisterRunnerDeploymentResult } from "../../restate/endpoint.js";
import {
  registerRunnerDeploymentWithRetry,
  type RunnerDeploymentRegistrationResult,
} from "../../restate/runner-registration.js";
import { VARIANTS, callWorkflow, eventually, gate, journalEntries, queryInvocations, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

interface FixtureInput {
  /** Milliseconds after the workflow starts. Negative starts already past the deadline. */
  bootstrapInMs: number;
  sleepMs: number;
}

interface FixtureScript {
  readUri: () => string | null | Promise<string | null>;
  readState: () => BackendRunState | Promise<BackendRunState>;
  register: (uri: string) => Promise<RegisterRunnerDeploymentResult>;
  readUriCalls: number;
  readStateCalls: number;
  registerCalls: number;
}

const scripts = new Map<string, FixtureScript>();

const fixture = restate.workflow({
  name: "RunnerRegistrationFixture",
  handlers: {
    run: async (ctx: WorkflowContext, input: FixtureInput): Promise<RunnerDeploymentRegistrationResult> => {
      const script = scripts.get(ctx.key);
      if (!script) throw new Error(`no runner registration script for ${ctx.key}`);
      const startedAt = await ctx.date.now();
      return registerRunnerDeploymentWithRetry(ctx, {
        readUri: () => script.readUri(),
        readContainerState: () => script.readState(),
        bootstrapDeadlineAt: startedAt + input.bootstrapInMs,
        sleepMs: input.sleepMs,
        register: (uri) => script.register(uri),
      });
    },
  },
});

const runnerRegistrationProbe = restate.service({
  name: "RunnerRegistrationProbe",
  handlers: { ping: async (_ctx: restate.Context) => "pong" },
});

interface RunnerEndpoint {
  server: http2.Http2Server;
  port: number;
  sessions: Set<http2.ServerHttp2Session>;
}

async function startRunnerEndpoint(port = 0): Promise<RunnerEndpoint> {
  const server = http2.createServer(createEndpointHandler({ services: [runnerRegistrationProbe] }));
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as net.AddressInfo).port, sessions };
}

async function stopRunnerEndpoint(endpoint: RunnerEndpoint): Promise<void> {
  await new Promise<void>((resolve) => {
    endpoint.server.close(() => resolve());
    for (const session of endpoint.sessions) session.destroy();
  });
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function makeScript(overrides: Partial<{
  uri: string | null;
  readUri: FixtureScript["readUri"];
  readState: FixtureScript["readState"];
  register: FixtureScript["register"];
}> = {}): FixtureScript {
  const script: FixtureScript = {
    readUriCalls: 0,
    readStateCalls: 0,
    registerCalls: 0,
    readUri: async () => {
      script.readUriCalls++;
      return overrides.uri ?? "http://127.0.0.1:1";
    },
    readState: async () => {
      script.readStateCalls++;
      return "started" as BackendRunState;
    },
    register: async () => {
      script.registerCalls++;
      return { ok: true, deploymentId: "dp_fake" };
    },
  };
  if (overrides.readUri) script.readUri = () => { script.readUriCalls++; return overrides.readUri!(); };
  if (overrides.readState) script.readState = () => { script.readStateCalls++; return overrides.readState!(); };
  if (overrides.register) script.register = (uri) => { script.registerCalls++; return overrides.register!(uri); };
  return script;
}

interface JournalCommand {
  type: string;
  name: string;
}

async function journalCommands(env: RestateEnvironment, key: string): Promise<JournalCommand[]> {
  const rows = await eventually(
    () => queryInvocations(
      env.adminAPIBaseUrl(),
      `target_service_name = 'RunnerRegistrationFixture' AND target_service_key = '${key}' AND target_handler_name = 'run'`,
    ),
    (found) => found.length === 1 && found[0]!.status === "completed",
    { label: `RunnerRegistrationFixture/${key} to complete` },
  );
  return (await journalEntries(env.adminAPIBaseUrl(), String(rows[0]!.id)))
    .filter((entry) => String(entry.entry_type).startsWith("Command: "))
    .map((entry) => ({ type: String(entry.entry_type).slice("Command: ".length), name: String(entry.name ?? "") }));
}

const registerSteps = (commands: JournalCommand[]) => commands.filter((command) => /^register-\d+$/.test(command.name));
const stateSteps = (commands: JournalCommand[]) => commands.filter((command) => /^state-\d+$/.test(command.name));
const sleeps = (commands: JournalCommand[]) => commands.filter((command) => command.type === "Sleep");
const sleepSteps = (commands: JournalCommand[]) => commands.filter((command) => /^sleep-\d+$/.test(command.name));
const indexOfRun = (commands: JournalCommand[], name: string) => commands.findIndex((command) => command.type === "Run" && command.name === name);
const indexOfSleep = (commands: JournalCommand[], name: string) => commands.findIndex((command) => command.type === "Sleep" && command.name === name);
const numberedNames = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

describe("registerRunnerDeploymentWithRetry (Restate)", () => {
  let environments: Map<string, RestateEnvironment>;
  const endpoints: RunnerEndpoint[] = [];
  const deployments: Array<{ env: RestateEnvironment; deploymentId: string }> = [];

  beforeAll(async () => {
    environments = await startVariants([fixture]);
  }, 60_000);

  afterEach(async () => {
    for (const { env, deploymentId } of deployments.splice(0)) {
      await removeDeployment(deploymentId, { adminBaseUrl: env.adminAPIBaseUrl() }).catch(() => undefined);
    }
    for (const endpoint of endpoints.splice(0)) await stopRunnerEndpoint(endpoint);
  });

  afterAll(async () => {
    await stopAll(environments);
  });

  function envFor(label: string): RestateEnvironment {
    const env = environments.get(label);
    if (!env) throw new Error(`environment "${label}" did not start`);
    return env;
  }

  function callFixture(label: string, script: FixtureScript, input: FixtureInput): { key: string; done: Promise<RunnerDeploymentRegistrationResult> } {
    const key = randomUUID();
    scripts.set(key, script);
    const done = callWorkflow<RunnerDeploymentRegistrationResult>(envFor(label).baseUrl(), "RunnerRegistrationFixture", key, "run", input);
    return { key, done };
  }

  it.each(VARIANTS.map(([label]) => label))("returns the deployment id on the first attempt (%s)", async (label) => {
    const env = envFor(label);
    const endpoint = await startRunnerEndpoint();
    endpoints.push(endpoint);
    const script = makeScript({
      uri: `http://127.0.0.1:${endpoint.port}`,
      register: (uri) => registerRunnerDeployment(uri, { adminBaseUrl: env.adminAPIBaseUrl() }),
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    const result = await done;

    expect(result).toEqual({ ok: true, deploymentId: expect.stringMatching(/^dp_/) });
    if (!result.ok) throw new Error("registration unexpectedly failed");
    deployments.push({ env, deploymentId: result.deploymentId });
    expect(script.registerCalls).toBe(1);
    expect(script.readStateCalls).toBe(0);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1"]);
    expect(stateSteps(commands)).toHaveLength(0);
    expect(sleeps(commands)).toHaveLength(0);
  });

  it.each(VARIANTS.map(([label]) => label))("retries after a durable sleep when the endpoint opens late (%s)", async (label) => {
    const env = envFor(label);
    const port = await unusedLoopbackPort();
    const stateGate = gate("first state read before the runner endpoint opens");
    const script = makeScript({
      uri: `http://127.0.0.1:${port}`,
      readState: async () => {
        await stateGate.wait();
        return "started" as BackendRunState;
      },
      register: (uri) => registerRunnerDeployment(uri, { adminBaseUrl: env.adminAPIBaseUrl() }),
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    await stateGate.reached();
    const endpoint = await startRunnerEndpoint(port);
    endpoints.push(endpoint);
    stateGate.release();

    const result = await done;
    expect(result).toEqual({ ok: true, deploymentId: expect.stringMatching(/^dp_/) });
    if (!result.ok) throw new Error("registration unexpectedly failed");
    deployments.push({ env, deploymentId: result.deploymentId });
    expect(script.registerCalls).toBe(2);
    expect(script.readUriCalls).toBe(2);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1", "register-2"]);
    expect(stateSteps(commands).map((command) => command.name)).toEqual(["state-1"]);
    expect(registerSteps(commands)).toHaveLength(script.registerCalls);
    expect(sleepSteps(commands).map((command) => command.name)).toEqual(["sleep-1"]);
    expect(sleeps(commands)).toHaveLength(1);
    const firstRegister = indexOfRun(commands, "register-1");
    const state = indexOfRun(commands, "state-1");
    const sleep = indexOfSleep(commands, "sleep-1");
    const secondRegister = indexOfRun(commands, "register-2");
    expect(firstRegister).toBeLessThan(state);
    expect(state).toBeLessThan(sleep);
    expect(sleep).toBeLessThan(secondRegister);
  });

  it.each(VARIANTS.map(([label]) => label))("returns exited when the container ends before serving (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript({
      register: async () => ({ ok: false, reason: "unreachable" }),
      readState: async () => "ended" as BackendRunState,
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    await expect(done).resolves.toEqual({ ok: false, reason: "exited" });
    expect(script.registerCalls).toBe(1);
    expect(script.readStateCalls).toBe(1);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1"]);
    expect(stateSteps(commands).map((command) => command.name)).toEqual(["state-1"]);
    expect(sleeps(commands)).toHaveLength(0);
  });

  it.each(VARIANTS.map(([label]) => label))("returns bootstrap timeout when the endpoint never opens (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript({
      register: async () => ({ ok: false, reason: "unreachable" }),
      readState: async () => "unknown" as BackendRunState,
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 500, sleepMs: 50 });
    await expect(done).resolves.toEqual({ ok: false, reason: "bootstrap timeout" });
    // The state read is prompt, so the helper reaches the deadline by retrying through
    // durable sleeps rather than by a state step held open until the clock passes.
    expect(script.registerCalls).toBeGreaterThanOrEqual(2);
    expect(script.readStateCalls).toBe(script.registerCalls);

    const commands = await journalCommands(env, key);
    const attempts = registerSteps(commands);
    expect(attempts.map((command) => command.name)).toEqual(numberedNames("register", script.registerCalls));
    expect(stateSteps(commands).map((command) => command.name)).toEqual(numberedNames("state", script.registerCalls));
    const sleepNames = sleepSteps(commands).map((command) => command.name);
    expect(sleepNames.length).toBeGreaterThanOrEqual(1);
    expect(sleepNames).toEqual(numberedNames("sleep", sleepNames.length));
    expect(sleeps(commands)).toHaveLength(sleepNames.length);
    for (let index = 0; index < sleepNames.length; index++) {
      expect(indexOfRun(commands, `register-${index + 1}`)).toBeLessThan(indexOfRun(commands, `state-${index + 1}`));
      expect(indexOfRun(commands, `state-${index + 1}`)).toBeLessThan(indexOfSleep(commands, `sleep-${index + 1}`));
      // The final sleep is capped by the deadline and is followed by the timeout.
      if (index + 2 <= attempts.length) {
        expect(indexOfSleep(commands, `sleep-${index + 1}`)).toBeLessThan(indexOfRun(commands, `register-${index + 2}`));
      }
    }
  });

  it.each(VARIANTS.map(([label]) => label))("starts no registration when the bootstrap deadline has passed (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript();

    const { key, done } = callFixture(label, script, { bootstrapInMs: -1, sleepMs: 20 });
    await expect(done).resolves.toEqual({ ok: false, reason: "bootstrap timeout" });
    expect(script.readUriCalls).toBe(0);
    expect(script.registerCalls).toBe(0);
    expect(script.readStateCalls).toBe(0);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands)).toHaveLength(0);
    expect(sleeps(commands)).toHaveLength(0);
  });

  it.each(VARIANTS.map(([label]) => label))("treats a throwing register function as one unreachable attempt (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript({
      register: async () => {
        throw new Error("connection reset");
      },
      readState: async () => "ended" as BackendRunState,
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    await expect(done).resolves.toEqual({ ok: false, reason: "exited" });
    expect(script.registerCalls).toBe(1);
    expect(script.readStateCalls).toBe(1);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands)).toHaveLength(1);
    expect(stateSteps(commands)).toHaveLength(1);
    expect(sleeps(commands)).toHaveLength(0);
  });

  it.each(VARIANTS.map(([label]) => label))("treats a null URI as unreachable and registers on the next attempt (%s)", async (label) => {
    const env = envFor(label);
    let uriReads = 0;
    const script = makeScript({
      readUri: async () => {
        uriReads++;
        if (uriReads === 1) return null;
        return "http://127.0.0.1:1";
      },
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    const result = await done;

    expect(result).toEqual({ ok: true, deploymentId: "dp_fake" });
    expect(script.readUriCalls).toBe(2);
    expect(script.registerCalls).toBe(1);
    expect(script.readStateCalls).toBe(1);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1", "register-2"]);
    expect(stateSteps(commands).map((command) => command.name)).toEqual(["state-1"]);
    expect(registerSteps(commands)).toHaveLength(2);
    expect(sleepSteps(commands).map((command) => command.name)).toEqual(["sleep-1"]);
    expect(sleeps(commands)).toHaveLength(1);
  });

  it.each(VARIANTS.map(([label]) => label))("treats a throwing URI read as unreachable and registers on the next attempt (%s)", async (label) => {
    const env = envFor(label);
    let uriReads = 0;
    const script = makeScript({
      readUri: async () => {
        uriReads++;
        if (uriReads === 1) throw new Error("docker daemon busy");
        return "http://127.0.0.1:1";
      },
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    const result = await done;

    expect(result).toEqual({ ok: true, deploymentId: "dp_fake" });
    expect(script.readUriCalls).toBe(2);
    expect(script.registerCalls).toBe(1);
    expect(script.readStateCalls).toBe(1);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1", "register-2"]);
    expect(stateSteps(commands).map((command) => command.name)).toEqual(["state-1"]);
    expect(sleepSteps(commands).map((command) => command.name)).toEqual(["sleep-1"]);
    expect(sleeps(commands)).toHaveLength(1);
  });

  it.each(VARIANTS.map(([label]) => label))("retries after an unknown state, then succeeds (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript({
      register: async () =>
        script.registerCalls === 1 ? { ok: false, reason: "unreachable" } : { ok: true, deploymentId: "dp_after_unknown" },
      readState: async () => "unknown" as BackendRunState,
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    await expect(done).resolves.toEqual({ ok: true, deploymentId: "dp_after_unknown" });
    expect(script.registerCalls).toBe(2);
    expect(script.readStateCalls).toBe(1);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1", "register-2"]);
    expect(stateSteps(commands).map((command) => command.name)).toEqual(["state-1"]);
    expect(sleepSteps(commands).map((command) => command.name)).toEqual(["sleep-1"]);
    expect(indexOfRun(commands, "register-1")).toBeLessThan(indexOfRun(commands, "state-1"));
    expect(indexOfRun(commands, "state-1")).toBeLessThan(indexOfSleep(commands, "sleep-1"));
    expect(indexOfSleep(commands, "sleep-1")).toBeLessThan(indexOfRun(commands, "register-2"));
  });

  it.each(VARIANTS.map(([label]) => label))("stops at once with the status when registration is rejected (%s)", async (label) => {
    const env = envFor(label);
    const script = makeScript({
      register: async () => ({ ok: false, reason: "rejected", status: 409 }),
    });

    const { key, done } = callFixture(label, script, { bootstrapInMs: 5_000, sleepMs: 20 });
    await expect(done).resolves.toEqual({ ok: false, reason: "rejected", status: 409 });
    expect(script.registerCalls).toBe(1);
    expect(script.readUriCalls).toBe(1);
    expect(script.readStateCalls).toBe(0);

    const commands = await journalCommands(env, key);
    expect(registerSteps(commands).map((command) => command.name)).toEqual(["register-1"]);
    expect(stateSteps(commands)).toHaveLength(0);
    expect(sleeps(commands)).toHaveLength(0);
  });
});
