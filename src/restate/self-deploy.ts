/** Durable self-deploy. Delayed sends leave no sleeping invocation pinned to the old endpoint. */
import * as restate from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { resolveDeployTarget } from "../deploy-availability.js";
import type { DeployPolicy } from "../deploy-policy.js";
import { deployArgs } from "../deploy.js";
import type { Machine, MachineConfig } from "../fly-machines.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { RestateDrainCoordinator, type RestateDrainProbes } from "./drain.js";

import { mintSourceTokenOrJwt } from "../github-app-auth.js";
import { defaultFetchSignal, srcHeaders } from "../github.js";

const INGRESS_TIMEOUT_MS = 15_000;

export type SelfDeployPhase = "draining" | "applying" | "verifying" | "succeeded" | "failed" | "cancelled";
export interface SelfDeployRecord {
  deployId: string;
  phase: SelfDeployPhase;
  target: { repo: string; branch: "testing" | "main"; commit: string; image: string; source: "published" | "built" };
  requestedBy: string;
  startedAt: number;
  finishedAt: number | null;
  reason: "drain-timeout" | "apply-failed" | "verify-timeout" | null;
}
export interface SelfDeployConfig {
  flyDeployToken?: string;
  flyOrchestratorApp?: string;
  selfDeployTarget?: { owner: string; repo: string } | null;
  /** FLY_IMAGE_APP, set by the control plane when it owns machine configuration. */
  imageApp?: string;
  kgSourceRepo?: string | null;
}
export interface SelfDeployDeps {
  /** Read credentials only inside effects; this value is never returned to the journal. */
  config(): SelfDeployConfig;
  getDeployPolicy(): Pick<DeployPolicy, "watchedRepo" | "watchedRef">;
  head(target: { owner: string; repo: string }, branch: "testing" | "main"): Promise<string | null>;
  /** Publication marker read inside the target lookup effect. */
  imagePublished(target: { owner: string; repo: string }, commit: string): Promise<boolean>;
  fly: {
    listMachines(token: string, app: string): Promise<Machine[]>;
    getMachine(token: string, app: string, id: string): Promise<Machine>;
    updateMachine(token: string, app: string, id: string, config: MachineConfig): Promise<unknown>;
  };
  /** Execute against the source tarball at record.target.commit, without logging argv/secrets.
   * Stop the subprocess when signal aborts (including any remote build polling). */
  flyctl(record: SelfDeployRecord, args: string[], token: string, signal: AbortSignal): Promise<void>;
  kgToken(): Promise<string>;
  getInFlightWork(): readonly unknown[];
  drainProbes(excludeInvocationId: string): RestateDrainProbes;
  setHold(held: boolean): Promise<void>;
  /** Read this process's AI_IMPLEMENT_SOURCE_COMMIT inside the verify effect. */
  sourceCommit(): string | undefined;
  onOutcome(record: SelfDeployRecord, detail?: string): Promise<void>;
  limits?: { drainTimeoutMs?: number; drainPollMs?: number; verifyInitialMs?: number; verifyPollMs?: number; flyctlTimeoutMs?: number };
}
export interface SelfDeployOptions { applyFlyToml: boolean }
export interface SelfDeployStatus { deploy: SelfDeployRecord | null; options: SelfDeployOptions }
export type SelfDeploySetOptionsResult = { ok: true; options: SelfDeployOptions } | { ok: false; reason: "apply-fly-toml-refused" };
const DEFAULT_OPTIONS: SelfDeployOptions = { applyFlyToml: false };
export type SelfDeployStartResult = { deployId: string; commit: string; image: string; alreadyActive: boolean }
  | { reason: "not-configured" | "head-unknown" | "image-not-published" };
const requester = z.string().min(1).max(200);
const startSchema = z.object({ branch: z.enum(["testing", "main"]), requestedBy: requester }).strict();
export const isActiveSelfDeploy = (r: SelfDeployRecord | null): r is SelfDeployRecord => r !== null && ["draining", "applying", "verifying"].includes(r.phase);
const read = (ctx: restate.ObjectSharedContext) => ctx.get<SelfDeployRecord>("deploy");
const readOptions = async (ctx: restate.ObjectSharedContext): Promise<SelfDeployOptions> => ({ ...DEFAULT_OPTIONS, ...await ctx.get<SelfDeployOptions>("options") });

export function createSelfDeploy(deps: SelfDeployDeps) {
  const limits = { drainTimeoutMs: 75 * 60_000, drainPollMs: 30_000, verifyInitialMs: 180_000, verifyPollMs: 60_000, flyctlTimeoutMs: 10 * 60_000, ...deps.limits };
  // Bound each CLI call independently; the injected executor must also stop its subprocess.
  async function flyctl(record: SelfDeployRecord, args: string[], token: string) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("SelfDeploy flyctl deadline exceeded"));
          }, deps.limits?.flyctlTimeoutMs ?? (record.target.source === "built" ? 20 * 60_000 : limits.flyctlTimeoutMs));
        }),
        deps.flyctl(record, args, token, controller.signal),
      ]);
    } finally { clearTimeout(timer); }
  }
  function write(ctx: restate.ObjectContext, record: SelfDeployRecord) {
    ctx.set("deploy", record);
    ctx.console.info(`[self-deploy] ${record.deployId} ${record.phase}${record.phase === "draining" ? ` ${record.target.repo}` : ""} ${record.reason ?? ""}`);
  }
  function send(ctx: restate.ObjectContext, record: SelfDeployRecord, handler: "checkDrain" | "apply" | "verify", delay: number, input: { attempt: number } | undefined = undefined) {
    const self = ctx.objectSendClient({ name: "SelfDeploy" } as restate.VirtualObjectDefinition<"SelfDeploy", unknown>, ctx.key) as unknown as
      Record<typeof handler, (input: unknown, opts: restate.SendOpts<unknown>) => void>;
    self[handler](input, restate.rpc.sendOpts({ delay, headers: { "self-deploy-id": record.deployId } }));
  }
  function current(ctx: restate.ObjectContext, record: SelfDeployRecord | null, phase: SelfDeployPhase): record is SelfDeployRecord {
    return record?.phase === phase && ctx.request().headers.get("self-deploy-id") === record.deployId;
  }
  async function finish(ctx: restate.ObjectContext, record: SelfDeployRecord, phase: "succeeded" | "failed" | "cancelled", reason: SelfDeployRecord["reason"] = null, detail?: string) {
    const next = { ...record, phase, reason, finishedAt: await ctx.date.now() };
    write(ctx, next);
    await ctx.run("clear hold", () => deps.setHold(false));
    await ctx.run("record outcome", () => deps.onOutcome(next, detail));
  }
  async function start(ctx: restate.ObjectContext, input: z.infer<typeof startSchema>): Promise<SelfDeployStartResult> {
    const existing = await read(ctx);
    if (isActiveSelfDeploy(existing)) return { deployId: existing.deployId, commit: existing.target.commit, image: existing.target.image, alreadyActive: true };
    const found = await ctx.run("find target", async (): Promise<SelfDeployRecord["target"] | { reason: "not-configured" | "head-unknown" | "image-not-published" }> => {
      const config = deps.config();
      if (!config.flyDeployToken || !config.flyOrchestratorApp || !config.selfDeployTarget) return { reason: "not-configured" };
      const target = resolveDeployTarget({ ...config.selfDeployTarget, branch: input.branch, runningCommit: null }, deps.getDeployPolicy())!;
      const commit = await deps.head(target, input.branch);
      if (!commit) return { reason: "head-unknown" };
      const source = config.kgSourceRepo ? "built" : "published";
      const image = source === "built" ? `registry.fly.io/${ctx.key}:deploy-${commit.slice(0, 7)}`
        : `registry.fly.io/${config.imageApp ?? "builddown-orchestrator-image"}:${input.branch}-${commit.slice(0, 7)}`;
      if (source === "published") {
        try {
          if (!await deps.imagePublished(target, commit)) return { reason: "image-not-published" };
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 401 && status !== 403) throw error;
          ctx.console.warn(`[self-deploy] image check unauthorized HTTP ${status}`);
          return { reason: "image-not-published" };
        }
      }
      return { repo: `${target.owner}/${target.repo}`, branch: input.branch, commit, image, source };
    });
    if ("reason" in found) return found;
    const record: SelfDeployRecord = { deployId: ctx.rand.uuidv4(), phase: "draining", target: found, requestedBy: input.requestedBy, startedAt: await ctx.date.now(), finishedAt: null, reason: null };
    await ctx.run("set hold", () => deps.setHold(true));
    write(ctx, record);
    send(ctx, record, "checkDrain", 0);
    return { deployId: record.deployId, commit: found.commit, image: found.image, alreadyActive: false };
  }
  async function checkDrain(ctx: restate.ObjectContext) {
    const record = await read(ctx);
    if (!current(ctx, record, "draining")) return;
    const quiet = await ctx.run("quiet probe", async () => {
      const drain = new RestateDrainCoordinator(deps.drainProbes(ctx.request().id));
      drain.begin();
      const status = await drain.status();
      return deps.getInFlightWork().length === 0 && status.state === "drained";
    });
    if (quiet) {
      const next = { ...record, phase: "applying" as const };
      write(ctx, next);
      send(ctx, next, "apply", 0);
    } else if (await ctx.date.now() - record.startedAt >= limits.drainTimeoutMs) {
      await finish(ctx, record, "failed", "drain-timeout");
    } else send(ctx, record, "checkDrain", limits.drainPollMs);
  }
  async function apply(ctx: restate.ObjectContext) {
    const record = await read(ctx);
    if (!current(ctx, record, "applying")) return;
    send(ctx, record, "verify", limits.verifyInitialMs, { attempt: 1 });
    const wantToml = (await readOptions(ctx)).applyFlyToml;
    const policy = await ctx.run("apply policy", async () => {
      if (!wantToml) return "image";
      return deps.config().imageApp ? "refused" : "toml";
    });
    // Outside the retried effect so a partially applied multi-machine update logs this only once.
    if (policy === "refused") ctx.console.warn("[self-deploy] apply fly.toml refused: control plane owns machine config");
    // Keep old boolean journal results readable. New failures journal only sanitized detail.
    let result: boolean | { detail: string };
    try {
      result = await ctx.run<boolean | { detail: string }>("apply image", async () => {
        const config = deps.config();
        const token = config.flyDeployToken!;
        const secrets = [token];
        for (let attempt = 0; ; attempt++) {
          let operation = "listMachines";
          try {
            // An accepted update may have killed this process. Always reread machine config.
            const machines = await deps.fly.listMachines(token, ctx.key);
            operation = "getMachine";
            const fresh = [];
            for (const machine of machines) fresh.push(await deps.fly.getMachine(token, ctx.key, machine.id));
            if (fresh.length > 0 && fresh.every(m => m.config.image === record.target.image)) return true;
            if (record.target.source === "built") {
              operation = "flyctl deploy";
              const kgToken = await deps.kgToken();
              secrets.push(kgToken);
              const args = deployArgs({ app: ctx.key, sourceCommit: record.target.commit, sourceRepo: record.target.repo, sourceBranch: record.target.branch, kgSourceRepo: config.kgSourceRepo!, kgToken });
              await flyctl(record, [...args, "--image-label", `deploy-${record.target.commit.slice(0, 7)}`], token);
              return true;
            }
            if (policy === "toml") {
              operation = "flyctl deploy";
              await flyctl(record, ["deploy", "--image", record.target.image, "--detach", "--app", ctx.key], token);
            } else for (const machine of fresh) {
              operation = "updateMachine";
              if (machine.config.image !== record.target.image) await deps.fly.updateMachine(token, ctx.key, machine.id, { ...machine.config, image: record.target.image });
            }
            return true;
          } catch (error) {
            const builtDeployFailed = record.target.source === "built" && operation === "flyctl deploy";
            if (builtDeployFailed) {
              // The release may have stopped this process after accepting the deploy.
              // Reconcile once, but never start another remote build in this effect.
              try {
                const machines = await deps.fly.listMachines(token, ctx.key);
                const fresh = [];
                for (const machine of machines) fresh.push(await deps.fly.getMachine(token, ctx.key, machine.id));
                if (fresh.length > 0 && fresh.every(m => m.config.image === record.target.image)) return true;
              } catch {
                // Preserve the original deploy failure if reconciliation is unavailable.
              }
            }
            const raw = error instanceof Error ? error.message : "Unknown error";
            const status = (error as { status?: number } | null)?.status ?? (Number(raw.match(/(?:\(|\bHTTP\s+)([45]\d\d)\b/i)?.[1]) || undefined);
            // Keep flyctl diagnostics, but drop command/argv suffixes (including build secrets).
            let message = raw.replace(/(?:\bcommand\b|\bargv\b|(?<![\w/])flyctl\b(?! (?:exited\b|failed to start:|download failed:|timed out\b|deadline exceeded\b|digest mismatch:))|--)[\s\S]*/i, "[command redacted]")
              // Remove queries on relative paths as well as absolute URLs.
              .replace(/(?:https?:\/\/|\/)[^\s"'<>]*\?[^\s"'<>]*/gi, "[URL redacted]")
              .replace(/["']?[\w-]*(?:token|authorization|password|secret)[\w-]*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, "[credential redacted]")
              .replace(/https?:\/\/[^\s]+/gi, "[URL redacted]")
              .replace(/(?:bearer\s+|(?:token|authorization|password|secret)[\w-]*[\s=:]+)\S+/gi, "[credential redacted]");
            for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
            message = message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200);
            const detail = `${operation} HTTP ${status ?? "unknown"} ${message}`;
            ctx.console.warn(`[self-deploy] ${record.deployId} apply error ${detail}`);
            const machinesApi = ["listMachines", "getMachine", "updateMachine"].includes(operation);
            const fixed = status !== undefined && status >= 400 && status < 500
              && !(machinesApi && (status === 409 || status === 429));
            if (builtDeployFailed || fixed || attempt === 2) return { detail };
            await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1_000)));
          }
        }
      }, { maxRetryAttempts: 3, initialRetryInterval: 100, maxRetryInterval: 1_000 });
    } catch (error) {
      // Older apply effects journaled retry exhaustion as TerminalError. Replay must
      // still finish and release the hold; suspension and other errors must escape.
      if (!(error instanceof restate.TerminalError)) throw error;
      result = false;
    }
    if (result !== true) await finish(ctx, record, "failed", "apply-failed", typeof result === "object" ? result.detail : undefined);
    else write(ctx, { ...record, phase: "verifying" });
  }
  async function verify(ctx: restate.ObjectContext, input: { attempt: number }) {
    const record = await read(ctx);
    if (!current(ctx, record, "verifying")) return;
    const commit = await ctx.run("read source commit", () => deps.sourceCommit() ?? null);
    if (commit === record.target.commit) await finish(ctx, record, "succeeded");
    else if (input.attempt < 5) send(ctx, record, "verify", limits.verifyPollMs, { attempt: input.attempt + 1 });
    else await finish(ctx, record, "failed", "verify-timeout");
  }
  async function cancel(ctx: restate.ObjectContext, _input: { requestedBy: string }) {
    const record = await read(ctx);
    if (!isActiveSelfDeploy(record)) return { cancelled: false, reason: "no-active-deploy" };
    if (record.phase !== "draining") return { cancelled: false, reason: "too-late" };
    await finish(ctx, record, "cancelled");
    return { cancelled: true };
  }
  async function releaseUnownedHold(ctx: restate.ObjectContext) {
    if (isActiveSelfDeploy(await read(ctx))) return { released: false };
    await ctx.run("clear unowned hold", () => deps.setHold(false));
    return { released: true };
  }
  async function setOptions(ctx: restate.ObjectContext, input: SelfDeployOptions): Promise<SelfDeploySetOptionsResult> {
    // The control plane owns that machine's config; fly.toml would change its VM size and mount.
    if (input.applyFlyToml && await ctx.run("read image app", () => deps.config().imageApp ?? null)) {
      return { ok: false, reason: "apply-fly-toml-refused" };
    }
    ctx.set("options", input);
    return { ok: true, options: input };
  }
  async function status(ctx: restate.ObjectSharedContext): Promise<SelfDeployStatus> {
    return { deploy: await read(ctx) ?? null, options: await readOptions(ctx) };
  }
  return restate.object({ name: "SelfDeploy", handlers: {
    start: restate.handlers.object.exclusive({ input: serde.zod(startSchema) }, start),
    checkDrain: restate.handlers.object.exclusive({ ingressPrivate: true }, checkDrain),
    // A built deploy can take twenty minutes per attempt.
    // Leave room for three attempts and retry delays before the server aborts the effect.
    apply: restate.handlers.object.exclusive({ ingressPrivate: true, inactivityTimeout: 65 * 60_000, abortTimeout: 70 * 60_000 }, apply),
    verify: restate.handlers.object.exclusive({ ingressPrivate: true, input: serde.zod(z.object({ attempt: z.number().int().min(1).max(5) }).strict()) }, verify),
    cancel: restate.handlers.object.exclusive({ input: serde.zod(z.object({ requestedBy: requester }).strict()) }, cancel),
    setOptions: restate.handlers.object.exclusive({ input: serde.zod(z.object({ applyFlyToml: z.boolean() }).strict()) }, setOptions),
    releaseUnownedHold: restate.handlers.object.exclusive({ ingressPrivate: true }, releaseUnownedHold),
    status: restate.handlers.object.shared(status),
  } });
}

/** Loopback boot entry point: Restate ingress cannot call private object handlers directly. */
export const selfDeployRecovery = restate.service({
  name: "SelfDeployRecovery",
  handlers: {
    releaseUnownedHold: restate.handlers.handler({
      input: serde.zod(z.object({ key: z.string().min(1) }).strict()),
    }, async (ctx: restate.Context, input: { key: string }) =>
      ctx.objectClient<SelfDeployDefinition>({ name: "SelfDeploy" }, input.key).releaseUnownedHold()),
  },
});

/** GitHub returns statuses newest first; the first matching context is authoritative. */
export async function githubImagePublished(appId: string, privateKey: string, target: { owner: string; repo: string }, commit: string): Promise<boolean> {
  const { token } = await mintSourceTokenOrJwt(appId, privateKey, target.owner, {
    permissions: { statuses: "read" }, repositories: [target.repo],
  });
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${encodeURIComponent(commit)}/statuses?per_page=100&page=${page}`, {
      headers: srcHeaders(token), signal: defaultFetchSignal(),
    });
    if (!response.ok) {
      if (response.status === 404) return false;
      throw Object.assign(new Error(`Image publication status read failed HTTP ${response.status}`), { status: response.status });
    }
    const statuses = await response.json() as { context: string; state: string }[];
    const publication = statuses.find(status => status.context === "orchestrator-image/published");
    if (publication) return publication.state === "success";
    if (statuses.length < 100) return false;
  }
}

export type SelfDeployDefinition = ReturnType<typeof createSelfDeploy>;

/** The ingress surface the poll loop and the admin routes depend on; each call may throw when Restate is unreachable. */
export interface SelfDeployClient {
  start(input: { branch: "testing" | "main"; requestedBy: string }): Promise<SelfDeployStartResult>;
  cancel(input: { requestedBy: string }): Promise<{ cancelled: boolean; reason?: string }>;
  releaseUnownedHold(): Promise<{ released: boolean }>;
  status(): Promise<SelfDeployStatus>;
  setOptions(input: SelfDeployOptions): Promise<SelfDeploySetOptionsResult>;
}

export function createSelfDeployIngressClient(key: () => string = () => process.env.FLY_APP_NAME ?? "orchestrator", baseUrl: string = RESTATE_INGRESS_BASE_URL): SelfDeployClient {
  const ingress = () => restateClients.connect({ url: baseUrl, fetch: (input, init) => fetch(input as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }) });
  const obj = () => ingress().objectClient<SelfDeployDefinition>({ name: "SelfDeploy" }, key());
  return {
    start: async (input) => await obj().start(input),
    cancel: async (input) => await obj().cancel(input),
    releaseUnownedHold: async () => await ingress().serviceClient(selfDeployRecovery).releaseUnownedHold({ key: key() }),
    status: async () => await obj().status(),
    setOptions: async (input) => await obj().setOptions(input),
  };
}
