/**
 * Doubles for the external Codex boundary only (AII-1427): the `codex` child process and, for planning, the
 * native app-server protocol driver. Everything above them (createStageExecutor, the real CodexExecutor, the
 * runner-owned ModelAuthClient and its expected bootstrap) stays production code.
 *
 * Test files install the doubles by delegating from a passthrough `vi.mock` of `node:child_process` (only the
 * `codex` command) and of `createCodexPlanningDriver`; the mocks read the slots below from globalThis at call time.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MODEL_AUTH_ROUTES } from "../model-auth-contract.js";
import type { ModelAuthTransport } from "../model-auth-client.js";
import type { CodexProtocolDriver, CodexTransportRunInput } from "../pipeline/codex-planning-adapter.js";
import { NOW } from "./configured-run-fixture.js";

export const S_CHATGPT = "synthetic-chatgpt-plan-access-token-1234";
export const S_OPENAI = "synthetic-openai-api-key-value-5678";
export const S_AMBIENT = "synthetic-AMBIENT-openai-key-do-not-leak";

export interface CodexChildRecord {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdin: string;
}

type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string>; cwd?: string }) => ChildProcessWithoutNullStreams;

/** Mutable slots the passthrough mocks consult; reset between tests. */
export type CodexChildSlots = { spawn?: SpawnFn; driver?: CodexProtocolDriver };
/** Shared through globalThis so a `vi.mock` factory can read it at call time without importing this module. */
export const CODEX_CHILD_GLOBAL = "__aiiCodexChildSlots";
export const codexChild: CodexChildSlots = ((globalThis as Record<string, unknown>)[CODEX_CHILD_GLOBAL] ??= {}) as CodexChildSlots;

const ev = (o: unknown): string => JSON.stringify(o);

/** Installs a fake `codex` child. `exec` replays a successful JSONL turn; `hang` waits for SIGTERM (app-server planning). */
export function installCodexChild(mode: "exec" | "hang"): CodexChildRecord[] {
  const log: CodexChildRecord[] = [];
  codexChild.spawn = ((cmd, args, opts) => {
    const rec: CodexChildRecord = { cmd, args, env: opts.env, cwd: opts.cwd, stdin: "" };
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
      stdin,
      stdout,
      stderr,
      pid: undefined,
      kill: (sig: NodeJS.Signals) => {
        setImmediate(() => closeWith(null, sig));
        return true;
      },
      unref: () => {},
    });
    if (mode === "exec") {
      setImmediate(() => {
        for (const line of [
          ev({ type: "thread.started", thread_id: "t1" }),
          ev({ type: "turn.started" }),
          ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } }),
          ev({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
        ]) stdout.write(`${line}\n`);
        setImmediate(() => closeWith(0, null));
      });
    }
    return proc;
  }) as SpawnFn;
  return log;
}

/** Installs a protocol driver that behaves like a completed planning turn and writes one plan comment. */
export function installPlanningDriver(): CodexTransportRunInput[] {
  const inputs: CodexTransportRunInput[] = [];
  codexChild.driver = {
    async run(input) {
      inputs.push(input);
      const dir = join(input.workspaceDir, "ai-output", "comments");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "01-plan.md"), "# Plan\n");
      return {
        result: { stdout: "done", stderr: "", exitCode: 0, tokensUsed: 1, terminalStatus: { subtype: "success", isError: false }, signal: null },
        sawUnsafe: false,
        stopReason: null,
        threadId: "t1",
      };
    },
  };
  return inputs;
}

export function resetCodexChild(): void {
  delete codexChild.spawn;
  delete codexChild.driver;
}

/**
 * Loopback model-auth service. A checkout request carries only the profile id, so the credential kind comes from the
 * profile's auth mode in `authByProfile`. Every request and every issued checkout is recorded.
 */
export function codexLoopback(authByProfile: Readonly<Record<string, string>>) {
  const posts: Array<{ route: string; body: Record<string, unknown> }> = [];
  const checkouts: Array<{ profileId: unknown; authMode: string }> = [];
  const transport: ModelAuthTransport = {
    post: vi.fn(async (route: string, raw: string) => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      posts.push({ route, body });
      if (route !== MODEL_AUTH_ROUTES.checkout) return { status: 200, body: { version: 1, ok: true, acknowledged: true } };
      const authMode = authByProfile[String(body.profileId)];
      if (!authMode) return { status: 403, body: { version: 1, ok: false, category: "unauthorized" } };
      checkouts.push({ profileId: body.profileId, authMode });
      const secret =
        authMode === "codex-subscription"
          ? { kind: "chatgpt-access-token", accessToken: S_CHATGPT, expiresAt: NOW + 24 * 3_600_000 }
          : { kind: "api-key", apiKey: authMode === "openai-api-key" ? S_OPENAI : "synthetic-anthropic-key-0000" };
      return { status: 200, body: { version: 1, ok: true, profileId: body.profileId, authMode, secret } };
    }),
  };
  return { transport, posts, checkouts, routes: () => posts.map((p) => p.route) };
}
