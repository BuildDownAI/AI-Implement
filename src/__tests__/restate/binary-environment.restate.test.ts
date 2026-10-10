// Proves the binary-backed Restate environment (AII-914). Needs no Docker. Run with
// `npm run test:restate`.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import * as restate from "@restatedev/restate-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RestateBinaryNotFoundError, startBinaryEnvironment, type BinaryEnvironment } from "./binary-environment.js";
import { attachWorkflow, callService, callWorkflow } from "./harness.js";

const echo = restate.service({
  name: "binaryEcho",
  handlers: {
    ping: async (_ctx: restate.Context, input: { value: string }) => ({ echoed: input.value }),
  },
});

let thrown = 0;
const flaky = restate.service({
  name: "binaryFlaky",
  handlers: {
    once: async (ctx: restate.Context): Promise<string> => {
      // Journaled step: throws on its first attempt, succeeds when the engine retries it.
      return ctx.run("flaky", async () => {
        if (thrown++ === 0) throw new Error("first attempt fails");
        return "ok";
      });
    },
  },
});

const waiter = restate.workflow({
  name: "binaryWaiter",
  handlers: {
    run: async (ctx: restate.WorkflowContext): Promise<string> => ctx.promise<string>("go"),
    release: async (ctx: restate.WorkflowSharedContext, value: string): Promise<void> => {
      ctx.promise<string>("go").resolve(value);
    },
  },
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("binary Restate environment (AII-914)", () => {
  const envs: BinaryEnvironment[] = [];
  async function start(...args: Parameters<typeof startBinaryEnvironment>): Promise<BinaryEnvironment> {
    const env = await startBinaryEnvironment(...args);
    envs.push(env);
    return env;
  }
  afterAll(async () => {
    await Promise.all(envs.map((env) => env.stop()));
  });

  it("serves the ingress and admin API on loopback addresses of the spawned server", async () => {
    const env = await start({ services: [echo] });
    expect(new URL(env.baseUrl()).hostname).toBe("127.0.0.1");
    expect(new URL(env.adminAPIBaseUrl()).hostname).toBe("127.0.0.1");
  });

  it("answers a service handler through the ingress", async () => {
    const env = await start({ services: [echo] });
    // RESTATE_LISTEN_MODE=tcp: no unix socket may be created under the base directory.
    expect(readdirSync(env.baseDir(), { recursive: true }).map(String).filter((f) => f.endsWith(".sock"))).toEqual([]);
    expect(await callService(env.baseUrl(), "binaryEcho", "ping", { value: "hi" })).toEqual({ echoed: "hi" });
  }, 120_000);

  it("retries a throwing handler under alwaysReplay and fails at once under disableRetries", async () => {
    const [replay, noRetry] = await Promise.all([
      start({ services: [flaky], variant: "alwaysReplay" }),
      start({ services: [flaky], variant: "disableRetries" }),
    ]);
    thrown = 0;
    expect(await callService(replay.baseUrl(), "binaryFlaky", "once", undefined)).toBe("ok");
    thrown = 0;
    await expect(callService(noRetry.baseUrl(), "binaryFlaky", "once", undefined)).rejects.toThrow(/binaryFlaky\/once failed/);
  }, 120_000);

  it("resumes a workflow waiting on a durable promise after restart()", async () => {
    const env = await start({ services: [waiter], storage: "disk" });
    const key = randomUUID();
    const base = env.baseUrl();
    const submit = await fetch(`${base}/binaryWaiter/${key}/run/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(submit.ok).toBe(true);
    await env.startedRestateServer.restart();
    await callWorkflow(base, "binaryWaiter", key, "release", "resumed");
    await vi.waitFor(async () => expect(await attachWorkflow(base, "binaryWaiter", key)).toBe("resumed"), { timeout: 30_000, interval: 250 });
  }, 180_000);

  it("rejects with RestateBinaryNotFoundError when no platform binary resolves", async () => {
    await expect(startBinaryEnvironment({ services: [echo], resolveBinary: () => null })).rejects.toBeInstanceOf(
      RestateBinaryNotFoundError,
    );
  });

  it("stop() ends the child, removes the base directory, and is idempotent", async () => {
    const env = await startBinaryEnvironment({ services: [echo] });
    const pid = env.childPid();
    const dir = env.baseDir();
    expect(pid).toBeDefined();
    expect(alive(pid!)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    await env.stop();
    expect(alive(pid!)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    await expect(env.stop()).resolves.toBeUndefined();
  }, 120_000);
});
