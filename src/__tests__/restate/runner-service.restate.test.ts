// Restate 1.7.10 scenarios for the local runner's per-run service, `Runner_<runId>`
// (AII-2034). The fake pipeline stands in for `runAutonomous()`; every other part —
// the SDK endpoint, the Restate server, request identity, the journaled event loop,
// the retry/kill policy and the process entry — is the product's.
//
// The runner registers as a SECOND endpoint on its own port (POST /deployments),
// not through startVariants' internal endpoint, because a runner image serves one
// per-run service and the orchestrator's endpoint is a different process. The
// process-entry scenario also registers the spawned entry and invokes `run` through
// the Restate ingress, so a protocol-level rejection cannot pass it.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto, { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as http2 from "node:http2";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RUNNER_IDENTITY_KEY_ENV,
  RUNNER_ID_ENV,
  RUNNER_SERVICE_PORT,
  createRunnerService,
  runnerServiceName,
} from "../../runner-service.js";
import type { RunAutonomousResult } from "../../run-autonomous.js";
import {
  VARIANTS,
  callService,
  eventually,
  gate,
  journalEntries,
  journalEntryNames,
  journalText,
  queryInvocations,
  settle,
  startVariants,
  stopAll,
  type Gate,
  type RestateEnvironment,
} from "./harness.js";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNNER_HOST = "127.0.0.1";
const RUNNER_PROCESS_URI = `http://${RUNNER_HOST}:${RUNNER_SERVICE_PORT}`;
/** The server under test runs with two-second invoker timeouts (startVariants below). */
const SERVER_INACTIVITY_TIMEOUT_MS = 2_000;

/** A second endpoint the Restate server under test can reach. */
interface RunnerEndpoint {
  port: number;
  server: http2.Http2Server;
  close(): Promise<void>;
}

interface FakeRunState {
  starts: number;
  gate: Gate<void>;
  result: RunAutonomousResult;
  failure?: string;
}

function fakeState(result: RunAutonomousResult = { exitCode: 0 }, failure?: string): FakeRunState {
  return { starts: 0, gate: gate("fake pipeline"), result, failure };
}

function fakePipeline(state: FakeRunState): () => Promise<RunAutonomousResult> {
  return async () => {
    state.starts++;
    await state.gate.wait();
    if (state.failure) throw new Error(state.failure);
    return state.result;
  };
}

/** Counts each execution of a journaled `ev-i` callback, which is the engine's retry surface. */
interface EventStepCounter {
  counts: Map<number, number>;
  enteredAt: Map<number, number>;
}

function eventStepCounter(): EventStepCounter {
  return { counts: new Map(), enteredAt: new Map() };
}

function onEventStep(counter: EventStepCounter) {
  return (index: number): void => {
    counter.counts.set(index, (counter.counts.get(index) ?? 0) + 1);
    if (!counter.enteredAt.has(index)) counter.enteredAt.set(index, Date.now());
  };
}

async function listen(server: http2.Http2Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, RUNNER_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
  return address.port;
}

async function registerDeployment(env: RestateEnvironment, uri: string, label: string): Promise<void> {
  await eventually(
    async () => {
      const response = await fetch(`${env.adminAPIBaseUrl()}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri }),
      }).catch(() => null);
      if (response && !response.ok) await response.text();
      return response?.ok ?? false;
    },
    Boolean,
    { label, timeoutMs: 30_000 },
  );
}

/** Registers one runner service at a fresh loopback port with the variant's request-identity key. */
async function registerRunner(env: RestateEnvironment, service: restate.ServiceDefinition<string, unknown>): Promise<RunnerEndpoint> {
  const identityKey = env.identityKey();
  if (!identityKey) throw new Error("the variant was not started with requestIdentity");
  const server = http2.createServer(createEndpointHandler({ services: [service], identityKeys: [identityKey] }));
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  const port = await listen(server);
  try {
    await registerDeployment(env, `http://${RUNNER_HOST}:${port}`, "the runner deployment");
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    port,
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.destroy();
      });
    },
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** A request-identity v1 JWT: EdDSA over `header.payload`, with the path as `aud`. */
function identityToken(privatePem: string, kid: string, audience: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "EdDSA", kid }));
  const payload = base64url(JSON.stringify({ aud: audience, iat: nowSeconds, nbf: nowSeconds - 60, exp: nowSeconds + 60 }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(unsigned), crypto.createPrivateKey(privatePem));
  return `${unsigned}.${base64url(signature)}`;
}

async function directRequest(
  port: number,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  host = "127.0.0.1",
  body?: string | Buffer,
): Promise<{ status: number; body: string }> {
  const client = http2.connect(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      const request = client.request({ ":method": method, ":path": path, ...headers });
      const chunks: Buffer[] = [];
      let status = 0;
      request.on("response", (responseHeaders) => {
        status = Number(responseHeaders[":status"]);
      });
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      request.on("error", reject);
      request.end(body);
    });
  } finally {
    client.close();
  }
}

function directDiscover(port: number, headers: Record<string, string>, host = "127.0.0.1"): Promise<{ status: number; body: string }> {
  return directRequest(port, "/discover", "GET", { accept: "application/vnd.restate.endpointmanifest.v4+json", ...headers }, host);
}

function directStatus(port: number, headers: Record<string, string>, host = "127.0.0.1"): Promise<number> {
  return directDiscover(port, headers, host).then((answer) => answer.status);
}

/** A protobuf varint, used by the service-protocol frames below. */
function protobufVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function protobufVarintField(field: number, value: number): Buffer {
  return Buffer.concat([protobufVarint((field << 3) | 0), protobufVarint(value)]);
}

function protobufBytesField(field: number, value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([protobufVarint((field << 3) | 2), protobufVarint(bytes.length), bytes]);
}

/** One service-protocol message: an 8-byte type/flag/length header, then the protobuf payload. */
function invocationFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * A direct service-protocol invocation. A JSON `POST /invoke/...` cannot reach a
 * handler (the SDK answers 415); reaching it requires the StartMessage and
 * InputCommandMessage frames a Restate server would send. `known_entries` is one
 * because the input command is the journal's first entry.
 */
function directInvoke(port: number, service: string, headers: Record<string, string>, host = "127.0.0.1"): Promise<{ status: number; body: string }> {
  const invocationId = `inv_${randomUUID().replaceAll("-", "")}`;
  const start = Buffer.concat([
    protobufBytesField(1, invocationId),
    protobufBytesField(2, invocationId),
    protobufVarintField(3, 1),
    protobufVarintField(9, 42),
  ]);
  const input = Buffer.concat([
    protobufBytesField(14, protobufBytesField(1, JSON.stringify({ workflowKey: "process-entry-workflow" }))),
    protobufBytesField(12, "input"),
  ]);
  return directRequest(
    port,
    `/invoke/${service}/run`,
    "POST",
    { ...headers, "content-type": "application/vnd.restate.invocation.v7", "x-restate-invocation-id": invocationId },
    host,
    Buffer.concat([invocationFrame(0x0000, start), invocationFrame(0x0400, input)]),
  );
}

async function privateIdentityPem(env: RestateEnvironment): Promise<string> {
  return readFile(path.join(env.baseDir(), "store", "request-identity-private.pem"), "utf8");
}

function signedHeaders(env: RestateEnvironment, privatePem: string, audience: string): Record<string, string> {
  const key = env.identityKey();
  if (!key) throw new Error("the variant was not started with requestIdentity");
  return { "x-restate-signature-scheme": "v1", "x-restate-jwt-v1": identityToken(privatePem, key, audience) };
}

function invocationRows(env: RestateEnvironment, service: string) {
  return queryInvocations(env.adminAPIBaseUrl(), `target_service_name = '${service}' AND target_handler_name = 'run'`);
}

async function waitForInvocation(env: RestateEnvironment, service: string): Promise<Record<string, unknown>> {
  const rows = await eventually(() => invocationRows(env, service), (found) => found.length === 1, { label: `one ${service}.run invocation` });
  return rows[0];
}

async function waitForTerminal(env: RestateEnvironment, invocationId: string): Promise<Record<string, unknown>> {
  const rows = await eventually(
    () => queryInvocations(env.adminAPIBaseUrl(), `id = '${invocationId}'`),
    (found) => found.length === 1 && found[0].status === "completed",
    { label: `invocation ${invocationId} to end`, timeoutMs: 30_000 },
  );
  return rows[0];
}

/** The engine's retry records. The pinned server stores each failed attempt here as a `TransientError`. */
async function invocationJournalEvents(env: RestateEnvironment, invocationId: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${env.adminAPIBaseUrl()}/query`, { // restate-test-allow: sys_journal_events read, not an invocation lookup
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: `SELECT * FROM sys_journal_events WHERE id = '${invocationId}'` }),
  });
  if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
  return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
}

const placeholder = restate.service({
  name: "runnerServicePlaceholder",
  handlers: { ping: async () => "pong" },
});

let envs: Map<string, RestateEnvironment>;
const endpoints: RunnerEndpoint[] = [];

beforeAll(async () => {
  envs = await startVariants([placeholder], {
    requestIdentity: true,
    invokerTimeouts: { inactivity: "2s", abort: "2s" },
  });
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

describe("Runner_<runId> Restate service (AII-2034)", () => {
  it.each(VARIANTS)("a signed call to Runner_<runId>.run returns the fake pipeline result (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const state = fakeState({ exitCode: 3 });
    state.gate.release();
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    const result = await callService<RunAutonomousResult>(env.baseUrl(), runnerServiceName(runId), "run", { workflowKey: "workflow-key" });
    expect(result).toEqual({ exitCode: 3 });
    expect(state.starts).toBe(1);
    const invocation = await waitForInvocation(env, runnerServiceName(runId));
    expect(await journalEntryNames(env.adminAPIBaseUrl(), String(invocation.id))).toContain("ev-0");
  });

  it.each(VARIANTS)("an unsigned or invalidly signed request is rejected before the pipeline runs (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const state = fakeState();
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    expect(await directStatus(endpoint.port, {})).toBe(401);
    expect(await directStatus(endpoint.port, { "x-restate-signature-scheme": "v1", "x-restate-jwt-v1": "not-a-jwt" })).toBe(401);
    expect((await directInvoke(endpoint.port, service, {})).status).toBe(401);
    const other = generateKeyPairSync("ed25519");
    const privatePem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(await directStatus(endpoint.port, signedHeaders(env, privatePem, "/discover"))).toBe(401);
    expect((await directInvoke(endpoint.port, service, signedHeaders(env, privatePem, `/invoke/${service}/run`))).status).toBe(401);
    await settle(100);
    expect(state.starts).toBe(0);
  });

  it.each(VARIANTS)("a signed discover lists the runner service (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const state = fakeState();
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    const privatePem = await privateIdentityPem(env);
    const discovered = await directDiscover(endpoint.port, signedHeaders(env, privatePem, "/discover"));
    expect(discovered.status, discovered.body).toBe(200);
    expect(JSON.parse(discovered.body)).toMatchObject({ services: expect.arrayContaining([expect.objectContaining({ name: runnerServiceName(runId) })]) });
    expect(state.starts).toBe(0);
  });

  it.each(VARIANTS)("a server restart while run waits for an event completes it once and journals each step once (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const state = fakeState({ exitCode: 0 });
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    void callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey: "workflow-key" }).catch(() => undefined);
    const invocation = await waitForInvocation(env, service);
    await eventually(() => state.starts, (starts) => starts === 1, { label: "the fake pipeline to start" });
    await env.startedRestateServer.restart();
    state.gate.release();
    const terminal = await waitForTerminal(env, String(invocation.id));
    expect(terminal.completion_result).toBe("success");
    expect(state.starts).toBe(1);
    const names = (await journalEntryNames(env.adminAPIBaseUrl(), String(invocation.id))).filter((name) => /^ev-/.test(name));
    expect(names).toEqual(["ev-0"]);
  }, 60_000);

  it.each(VARIANTS)("stopping the runner endpoint ends the caller after the three-attempt kill policy (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const state = fakeState();
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    const pending = callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey: "workflow-key" }).then(() => null, (error: Error) => error);
    const invocation = await waitForInvocation(env, service);
    await eventually(() => state.starts, (starts) => starts === 1, { label: "the fake pipeline to start" });
    await endpoint.close();
    endpoints.splice(endpoints.indexOf(endpoint), 1);
    expect(await pending).toBeInstanceOf(Error);
    const terminal = await waitForTerminal(env, String(invocation.id));
    expect(terminal.completion_result).toBe("failure");
    const events = await invocationJournalEvents(env, String(invocation.id));
    const transientErrors = events.filter((event) => event.event_type === "TransientError");
    // Three attempts leave two failed attempts for the engine to retry.
    expect(transientErrors, JSON.stringify(events)).toHaveLength(2);
    expect(state.starts).toBe(1);
  }, 60_000);

  it.each(VARIANTS)("an event later than the server's inactivity timeout is still taken, without restarting the step (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const state = fakeState({ exitCode: 0 });
    const steps = eventStepCounter();
    const endpoint = await registerRunner(env, createRunnerService({
      runId,
      runAutonomous: fakePipeline(state),
      onEventStep: onEventStep(steps),
    }));
    endpoints.push(endpoint);
    const pending = callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey: "workflow-key" });
    const invocation = await waitForInvocation(env, service);
    await eventually(() => state.starts, (starts) => starts === 1, { label: "the fake pipeline to start" });
    const enteredAt = await eventually(() => steps.enteredAt.get(0), (value) => typeof value === "number", { label: "the ev-0 step to start" });
    // Hold the event past the server's shortened inactivity timeout. The proof is the
    // recorded interval below; this wait only gives the event time to get there.
    await eventually(
      () => Date.now() - enteredAt!,
      (elapsed) => elapsed >= SERVER_INACTIVITY_TIMEOUT_MS + 1_000,
      { timeoutMs: 15_000, intervalMs: 100, label: "the gated event to cross the server's inactivity timeout" },
    );
    const stillRunning = await queryInvocations(env.adminAPIBaseUrl(), `id = '${invocation.id}'`);
    expect(stillRunning[0]?.status).not.toBe("completed");
    // The callback is still on its first execution while the event is pending: the
    // engine neither replayed nor re-ran the step across the server's timeout.
    expect(steps.counts.get(0)).toBe(1);
    expect(state.starts).toBe(1);
    const releasedAt = Date.now();
    state.gate.release();
    expect(await pending).toEqual({ exitCode: 0 });
    expect(releasedAt - enteredAt!).toBeGreaterThanOrEqual(SERVER_INACTIVITY_TIMEOUT_MS + 1_000);
    expect(steps.counts.get(0)).toBe(1);
    const terminal = await waitForTerminal(env, String(invocation.id));
    expect(terminal.completion_result).toBe("success");
    expect((await journalEntryNames(env.adminAPIBaseUrl(), String(invocation.id))).filter((name) => /^ev-/.test(name))).toEqual(["ev-0"]);
    expect(state.starts).toBe(1);
  }, 60_000);

  it.each(VARIANTS)("two runners with two run ids each receive only their own call (%s)", async (label) => {
    const env = envs.get(label)!;
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = fakeState({ exitCode: 11 });
    const second = fakeState({ exitCode: 22 });
    first.gate.release();
    second.gate.release();
    const firstEndpoint = await registerRunner(env, createRunnerService({ runId: firstId, runAutonomous: fakePipeline(first) }));
    const secondEndpoint = await registerRunner(env, createRunnerService({ runId: secondId, runAutonomous: fakePipeline(second) }));
    endpoints.push(firstEndpoint, secondEndpoint);
    const [firstResult, secondResult] = await Promise.all([
      callService<RunAutonomousResult>(env.baseUrl(), runnerServiceName(firstId), "run", { workflowKey: "one" }),
      callService<RunAutonomousResult>(env.baseUrl(), runnerServiceName(secondId), "run", { workflowKey: "two" }),
    ]);
    expect(firstResult).toEqual({ exitCode: 11 });
    expect(secondResult).toEqual({ exitCode: 22 });
    expect(first.starts).toBe(1);
    expect(second.starts).toBe(1);
    expect(await invocationRows(env, runnerServiceName(firstId))).toHaveLength(1);
    expect(await invocationRows(env, runnerServiceName(secondId))).toHaveLength(1);
  });

  it.each(VARIANTS)("a fake pipeline that throws ends the call at once with a terminal failure (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const state = fakeState(undefined, "pipeline exploded");
    state.gate.release();
    const endpoint = await registerRunner(env, createRunnerService({ runId, runAutonomous: fakePipeline(state) }));
    endpoints.push(endpoint);
    await expect(callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey: "workflow-key" })).rejects.toThrow(/pipeline exploded/);
    const invocation = await waitForInvocation(env, service);
    const terminal = await waitForTerminal(env, String(invocation.id));
    expect(terminal.completion_result).toBe("failure");
    expect(String(terminal.completion_failure)).toMatch(/pipeline exploded/);
    // A failure event ends the handler on the first `ctx.run`; the engine records no retry.
    expect(await invocationJournalEvents(env, String(invocation.id))).toEqual([]);
    expect((await journalEntryNames(env.adminAPIBaseUrl(), String(invocation.id))).filter((name) => /^ev-/.test(name))).toEqual(["ev-0"]);
    expect(state.starts).toBe(1);
  });

  it.each(VARIANTS)("a credential-bearing failure is scrubbed from the input, event and terminal error (%s)", async (label) => {
    const env = envs.get(label)!;
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const workflowKey = `workflow-key-nonsecret-${randomUUID()}`;
    const envSecret = `env-secret-${randomUUID()}`;
    const tokenSecret = `ghs_${randomUUID().replaceAll("-", "")}`;
    const marker = `nonsecret-marker-${randomUUID()}`;
    const state = fakeState(undefined, `pipeline failed near ${marker} with ${envSecret} and ${tokenSecret}`);
    state.gate.release();
    const endpoint = await registerRunner(env, createRunnerService({
      runId,
      runAutonomous: fakePipeline(state),
      env: { MODEL_API_KEY: envSecret },
    }));
    endpoints.push(endpoint);
    const rejection = await callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey }).then(() => null, (error: Error) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection!.message).toContain(marker);
    expect(rejection!.message).not.toContain(envSecret);
    expect(rejection!.message).not.toContain(tokenSecret);
    const invocation = await waitForInvocation(env, service);
    const terminal = await waitForTerminal(env, String(invocation.id));
    const terminalText = JSON.stringify(terminal);
    expect(terminalText).toContain(marker);
    expect(terminalText).not.toContain(envSecret);
    expect(terminalText).not.toContain(tokenSecret);
    const decoded = journalText(await journalEntries(env.adminAPIBaseUrl(), String(invocation.id)));
    // Prove the absence checks searched a populated journal: the input payload and the
    // sanitized failure event are both present, so the decoded text is not empty.
    expect(decoded).toContain(workflowKey);
    expect(decoded).toContain(marker);
    expect(decoded).not.toContain(envSecret);
    expect(decoded).not.toContain(tokenSecret);
    expect((await journalEntryNames(env.adminAPIBaseUrl(), String(invocation.id))).filter((name) => /^ev-/.test(name))).toEqual(["ev-0"]);
  });
});

describe("runner-service process entry (AII-2034)", () => {
  let buildDir: string;
  let entry: string;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // Inside the repo so the compiled entry resolves `@restatedev/*` from the repo's node_modules.
    buildDir = await mkdtemp(path.join(REPO_ROOT, ".runner-service-build-"));
    const tsc = require.resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "--outDir", buildDir, "--declaration", "false", "--sourceMap", "false"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    entry = path.join(buildDir, "runner-service.js");
  }, 120_000);

  afterAll(async () => {
    await rm(buildDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    const proc = child;
    child = undefined;
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
  });

  function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? os.tmpdir(),
      TMPDIR: os.tmpdir(),
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
      // The built entry's own pipeline reads this envelope and fails fast, so the
      // signed ingress call still executes the real handler and returns its failure.
      AI_IMPLEMENT_RUN_CONFIG: "not-a-valid-envelope",
      NODE_DISABLE_COMPILE_CACHE: "1",
      ...extra,
    };
  }

  async function startEntry(runId: string, identityKey: string): Promise<ChildProcess> {
    const proc = spawn(process.execPath, [entry], {
      env: childEnv({ [RUNNER_ID_ENV]: runId, [RUNNER_IDENTITY_KEY_ENV]: identityKey }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let output = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await eventually(
      () => proc.exitCode !== null || output.includes("listening on"),
      Boolean,
      { label: "the runner process entry to listen", timeoutMs: 15_000 },
    );
    if (proc.exitCode !== null) throw new Error(`runner entry exited during startup: ${output}`);
    return proc;
  }

  it.each(VARIANTS)("serves a signed run through ingress on 127.0.0.1 and signed discovery on ::1 (%s)", async (label) => {
    const env = envs.get(label)!;
    const identityKey = env.identityKey();
    if (!identityKey) throw new Error("the variant was not started with requestIdentity");
    const runId = randomUUID();
    const service = runnerServiceName(runId);
    const proc = await startEntry(runId, identityKey);
    await registerDeployment(env, RUNNER_PROCESS_URI, "the spawned runner deployment");

    // The ingress call is the product path: the Restate server signs with its private
    // key, the runner verifies it, and the real `runAutonomous()` fails on the invalid
    // RunConfig. A protocol error (415) or an auth rejection (401) cannot answer this.
    await expect(callService<RunAutonomousResult>(env.baseUrl(), service, "run", { workflowKey: "process-entry-workflow" }))
      .rejects.toThrow(/run_config is not valid base64 JSON/);
    const invocation = await waitForInvocation(env, service);
    const terminal = await waitForTerminal(env, String(invocation.id));
    expect(terminal.completion_result).toBe("failure");
    expect(String(terminal.completion_failure)).toMatch(/run_config is not valid base64 JSON/);

    // The container stays up after the call, and the listener answers a signed
    // request on both IP families. A 200 manifest naming the service cannot pass on a
    // protocol rejection or an unsigned request; an unsigned probe here gets 401.
    expect(proc.exitCode).toBeNull();
    const privatePem = await privateIdentityPem(env);
    for (const host of ["127.0.0.1", "::1"] as const) {
      expect(await directStatus(RUNNER_SERVICE_PORT, {}, host)).toBe(401);
      const discovered = await directDiscover(RUNNER_SERVICE_PORT, signedHeaders(env, privatePem, "/discover"), host);
      expect(discovered.status, discovered.body).toBe(200);
      expect(JSON.parse(discovered.body)).toMatchObject({ services: expect.arrayContaining([expect.objectContaining({ name: service })]) });
    }

    // The listener must also accept a signed run on IPv6. The answer is the real
    // pipeline's failure, so a 401 or a protocol rejection (415) cannot pass it.
    const ipv6Run = await directInvoke(RUNNER_SERVICE_PORT, service, signedHeaders(env, privatePem, `/invoke/${service}/run`), "::1");
    expect(ipv6Run.status, ipv6Run.body).toBe(200);
    expect(ipv6Run.body).toContain("run_config is not valid base64 JSON");
    expect(proc.exitCode).toBeNull();
  }, 60_000);

  it("exits with an error when AI_IMPLEMENT_RUNNER_ID or RESTATE_IDENTITY_KEY is missing", () => {
    const publicKey = envs.get("alwaysReplay")!.identityKey()!;
    for (const env of [{ [RUNNER_IDENTITY_KEY_ENV]: publicKey }, { [RUNNER_ID_ENV]: randomUUID() }]) {
      const result = spawnSync(process.execPath, [entry], { env: childEnv(env), timeout: 15_000, stdio: "pipe" });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr.toString()).toMatch(/refusing to start/);
    }
  }, 60_000);
});
