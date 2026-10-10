// Shared setup for every Restate test (AII-716). A test file under this folder never
// declares its own server, variants, start/stop hooks, or fetch helper — it imports them
// from here. See docs/restate.md § Testing for the rule. Every environment is the
// `restate-server` binary the product runs (AII-1195).
import type { ServiceDefinition, VirtualObjectDefinition, WorkflowDefinition } from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { startBinaryEnvironment } from "./binary-environment.js";
import type { BinaryEnvironment } from "./binary-environment.js";

/** The environment type the scenario files import: the binary environment. */
export type RestateEnvironment = BinaryEnvironment;

type RestateServices = Array<
  ServiceDefinition<string, unknown> | VirtualObjectDefinition<string, unknown> | WorkflowDefinition<string, unknown>
>;

// Both variants are proven for AII-683: each environment boots the same services with
// one of the two server options (see startBinaryEnvironment's `variant`). Each entry is a
// one-element tuple, `[label]`, which is the shape the scenario files destructure.
export const VARIANTS = [["alwaysReplay"], ["disableRetries"]] as const satisfies ReadonlyArray<readonly ["alwaysReplay" | "disableRetries"]>;

export async function startVariants(services: RestateServices): Promise<Map<string, RestateEnvironment>> {
  const started = await Promise.all(
    VARIANTS.map(async ([variant]) => [variant, await startBinaryEnvironment({ services, variant })] as const),
  );
  return new Map(started);
}

/** Fault-injection scenarios need the engine's normal retry policy. The binary keeps
 * its journal on disk across a restart of the server. */
export async function startRetryEnabled(services: RestateServices): Promise<RestateEnvironment> {
  return startBinaryEnvironment({ services, storage: "disk" });
}

/** Replace only the SDK endpoint, keeping the Restate server and its journal.
 * A server restart after this closes its old HTTP/2 sessions and reconnects to
 * the replacement endpoint at the same address. */
export async function replaceEndpoint(env: RestateEnvironment, services: RestateServices): Promise<http2.Http2Server> {
  const old = env.startedRestateHttpServer;
  const address = old.address() as AddressInfo;
  old.close();
  const replacement = http2.createServer(createEndpointHandler({ services }));
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(address.port, address.address, resolve);
  });
  return replacement;
}

export async function stopAll(environments: Map<string, RestateEnvironment> | undefined): Promise<void> {
  if (!environments) return;
  await Promise.all([...environments.values()].map((env) => env.stop()));
}

/**
 * Wraps an async external effect so its first call performs the real effect and then
 * throws, simulating the "commit/dispatch/write succeeded but the caller crashed before
 * observing the acknowledgement" window a fault-injection scenario needs: the durable
 * `ctx.run` step this effect lives in sees a thrown error and the engine retries it, so
 * the assertion is "did the effect run exactly once, and did the retry reconcile instead
 * of repeating it" — never a journal internal. Every call after the first behaves
 * normally, so a scenario that also needs the effect's eventual real return value
 * (e.g. to keep driving the same fixture) still gets it on the retried attempt.
 */
export function crashAfterFirstCall<Args extends unknown[], R>(
  effect: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let crashed = false;
  return async (...args: Args): Promise<R> => {
    const result = await effect(...args);
    if (!crashed) {
      crashed = true;
      throw new Error("injected crash: effect committed, caller never observed the response");
    }
    return result;
  };
}

// A `void` handler answers with an empty body on success. Reading response.text() first
// (rather than calling response.json() directly) lets an empty 2xx body resolve to
// `undefined` instead of throwing a JSON-parse error — the AII-709 regression: its
// pre-extraction copy of this helper called response.json() unconditionally and failed
// all 13 scenarios against issue/revoke.
async function post<T>(url: string, label: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

// Matches what serviceClient builds in @restatedev/restate-sdk-clients' ingress
// (doComponentInvocation): `${url}/${service}/${handler}`, with no `/restate/` prefix —
// that prefix is reserved for admin/introspection routes, not for invoking a handler.
export async function callService<T>(
  baseUrl: string,
  service: string,
  handler: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return post<T>(`${baseUrl}/${service}/${handler}`, `${service}/${handler}`, body, headers);
}

// Same convention for a virtual object: `${url}/${object}/${key}/${handler}`.
export async function callObject<T>(baseUrl: string, object: string, key: string, handler: string, body: unknown): Promise<T> {
  return post<T>(`${baseUrl}/${object}/${encodeURIComponent(key)}/${handler}`, `${object}/${key}/${handler}`, body);
}

export async function callWorkflow<T>(baseUrl: string, workflow: string, key: string, handler: string, body: unknown = {}): Promise<T> {
  return post<T>(`${baseUrl}/${workflow}/${encodeURIComponent(key)}/${handler}`, `${workflow}/${key}/${handler}`, body);
}

export async function attachWorkflow<T>(baseUrl: string, workflow: string, key: string): Promise<T> {
  return post<T>(`${baseUrl}/restate/attach`, `${workflow}/${key}/attach`, {
    target: "workflow", workflowName: workflow, workflowKey: key,
  });
}

/** Poll `read` until `accept` approves the value, and return that value. On timeout the
 *  error names `label` and prints the last value read, so a flake reads as a diagnosis
 *  rather than a bare assertion diff. State produced by a one-way send, a schedule, or a
 *  resolve is always read through this, never behind a fixed sleep. */
export async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 25, label = "condition" } = opts;
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > stop) {
      let printed: string;
      try {
        printed = JSON.stringify(value) ?? String(value);
      } catch {
        printed = String(value);
      }
      throw new Error(`eventually timed out after ${timeoutMs}ms waiting for ${label}; last value: ${printed}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs)); // restate-test-allow: the poll interval of eventually itself
  }
}

/** One `POST /query` on `sys_invocation` with the given `WHERE` text; returns `rows`.
 *  Wrap it in `eventually` — a scheduled send is not always visible the moment it is made. */
export async function queryInvocations(adminBaseUrl: string, where: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${adminBaseUrl}/query`, { // restate-test-allow: the one sanctioned admin read
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: `SELECT * FROM sys_invocation WHERE ${where}` }),
  });
  if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
  return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
}

/** The full `sys_journal` rows of one invocation. A test that must prove a value is absent from the journal searches these. */
export async function journalEntries(adminBaseUrl: string, invocationId: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${adminBaseUrl}/query`, { // restate-test-allow: sys_journal read, not an invocation lookup
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: `SELECT * FROM sys_journal WHERE id = '${invocationId}'` }),
  });
  if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
  return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
}

/** The journal rows as searchable text: JSON as given, plus every byte array in it (Restate stores payloads as
 *  `[123,34,...]`) decoded as UTF-8. A "this value is not in the journal" assertion searches this, not the raw JSON. */
export function journalText(entries: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 256)) {
        parts.push(Buffer.from(value as number[]).toString("utf8"));
      } else {
        value.forEach(visit);
      }
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  for (const entry of entries) {
    parts.push(JSON.stringify(entry));
    if (typeof entry.entry_json === "string") visit(JSON.parse(entry.entry_json));
  }
  return parts.join("\n");
}

/** The JSON value a named `ctx.run` step journaled: the `Run` command's completion id, matched to its completion notification. */
export function journaledRunResult(entries: Array<Record<string, unknown>>, stepName: string): unknown {
  const parsed = entries.map((e) => JSON.parse(String(e.entry_json ?? "null")) as Record<string, any> | null);
  const command = parsed.find((e) => e?.Command?.Run?.name === stepName);
  if (!command) throw new Error(`no journal entry for step ${stepName}`);
  const completionId = command.Command.Run.completion_id;
  const done = parsed.find((e) => e?.Notification?.Completion?.Run?.completion_id === completionId);
  const success = done?.Notification?.Completion?.Run?.result?.Success as number[] | undefined;
  if (!success) throw new Error(`step ${stepName} has no journaled success result`);
  return success.length === 0 ? undefined : JSON.parse(Buffer.from(success).toString("utf8"));
}

/** The names of an invocation's journal entries, in journal order: `ctx.run` step names show the order a workflow ran its steps. */
export async function journalEntryNames(adminBaseUrl: string, invocationId: string): Promise<string[]> {
  const response = await fetch(`${adminBaseUrl}/query`, { // restate-test-allow: sys_journal read, not an invocation lookup
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: `SELECT name FROM sys_journal WHERE id = '${invocationId}'` }),
  });
  if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
  const rows = ((await response.json()) as { rows: Array<{ name?: string | null }> }).rows;
  return rows.map((r) => r.name ?? "").filter((n) => n !== "");
}

/** Cancels one invocation through the admin API (`PATCH /invocations/<id>/cancel`); `id` is a `sys_invocation` row id. */
export async function cancelInvocation(adminBaseUrl: string, id: string): Promise<void> {
  const response = await fetch(`${adminBaseUrl}/invocations/${encodeURIComponent(id)}/cancel`, { method: "PATCH" });
  if (!response.ok) throw new Error(`cancel of invocation ${id} failed: HTTP ${response.status}`);
}

/** The one permitted wait: use it only before a NEGATIVE assertion ("nothing more
 *  happens"). Waiting for something to become true is `eventually`, never a sleep. */
export async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms)); // restate-test-allow: settle is the sanctioned negative wait
}

/** Poll a status read until its `step` equals `step`. The read is a status handler that
 *  returns `{ step }` (for `KgRefresh`, the `status` shared handler). A test that sends a
 *  signal calls this first, so it acts only after the workflow reached the named step. */
export async function waitForStep<S extends { step: string | null }>(
  read: () => S | Promise<S>,
  step: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<S> {
  return eventually(read, (status) => status.step === step, { label: `step ${step}`, ...opts });
}

export interface Gate<T = void> {
  /** Called by a fake. The first call marks the gate reached and parks until `release`;
   *  every call after `release` resolves at once with the released value. */
  wait(): Promise<T>;
  /** Releases every parked `wait()` and every later one. A second call is ignored. */
  release(value: T): void;
  /** Resolves once a fake has called `wait()`; rejects naming `label` after `timeoutMs` (default 10 s). */
  reached(opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  isReached(): boolean;
}

/** A single-use gate that holds a fake dependency until the test releases it. It never
 *  re-arms: a re-arming gate would park a retried `ctx.run` step again and deadlock the
 *  scenario with no message. `reached()` polls with `eventually`, so it adds no timer. */
export function gate<T = void>(label: string): Gate<T> {
  let reached = false;
  let released = false;
  let value: T;
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => {
    open = resolve;
  });
  return {
    wait() {
      reached = true;
      return released ? Promise.resolve(value) : opened;
    },
    release(next: T) {
      if (released) return;
      released = true;
      value = next;
      open(next);
    },
    async reached(opts = {}) {
      await eventually(() => reached, Boolean, { ...opts, label: `gate "${label}" to be reached` });
    },
    isReached: () => reached,
  };
}
