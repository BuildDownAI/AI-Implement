/** Durable self-deploy. Delayed sends leave no sleeping invocation pinned to the old endpoint. */
import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { deployArgs } from "../deploy.js";
import type { Machine, MachineConfig } from "../fly-machines.js";
import { RestateDrainCoordinator, type RestateDrainProbes } from "./drain.js";

export type SelfDeployPhase = "draining" | "applying" | "verifying" | "succeeded" | "failed" | "cancelled";
export interface SelfDeployRecord {
  deployId: string;
  phase: SelfDeployPhase;
  target: { branch: "testing" | "main"; commit: string; image: string; source: "published" | "built" };
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
  head(target: { owner: string; repo: string }, branch: "testing" | "main"): Promise<string | null>;
  /** Manifest HEAD, returning its HTTP status. */
  registryHead(image: string, token: string): Promise<number>;
  fly: {
    listMachines(token: string, app: string): Promise<Machine[]>;
    getMachine(token: string, app: string, id: string): Promise<Machine>;
    updateMachine(token: string, app: string, id: string, config: MachineConfig): Promise<unknown>;
  };
  /** Execute against the source tarball at record.target.commit, without logging argv/secrets. */
  flyctl(record: SelfDeployRecord, args: string[], token: string): Promise<void>;
  kgToken(): Promise<string>;
  applyFlyToml(): boolean | Promise<boolean>;
  getInFlightWork(): readonly unknown[];
  drainProbes(excludeInvocationId: string): RestateDrainProbes;
  setHold(held: boolean): Promise<void>;
  /** Read this process's AI_IMPLEMENT_SOURCE_COMMIT inside the verify effect. */
  sourceCommit(): string | undefined;
  onOutcome(record: SelfDeployRecord): Promise<void>;
  limits?: { drainTimeoutMs?: number; drainPollMs?: number; verifyInitialMs?: number; verifyPollMs?: number };
}
export type SelfDeployStartResult = { deployId: string; commit: string; image: string; alreadyActive: boolean }
  | { reason: "not-configured" | "head-unknown" | "image-not-published" };
const requester = z.string().min(1).max(200);
const startSchema = z.object({ branch: z.enum(["testing", "main"]), requestedBy: requester }).strict();
const active = (r: SelfDeployRecord | null): r is SelfDeployRecord => r !== null && ["draining", "applying", "verifying"].includes(r.phase);
const read = (ctx: restate.ObjectSharedContext) => ctx.get<SelfDeployRecord>("deploy");

export function createSelfDeploy(deps: SelfDeployDeps) {
  const limits = { drainTimeoutMs: 75 * 60_000, drainPollMs: 30_000, verifyInitialMs: 180_000, verifyPollMs: 60_000, ...deps.limits };
  function write(ctx: restate.ObjectContext, record: SelfDeployRecord) {
    ctx.set("deploy", record);
    ctx.console.info(`[self-deploy] ${record.deployId} ${record.phase} ${record.reason ?? ""}`);
  }
  function send(ctx: restate.ObjectContext, record: SelfDeployRecord, handler: "checkDrain" | "apply" | "verify", delay: number, input: { attempt: number } | undefined = undefined) {
    const self = ctx.objectSendClient({ name: "SelfDeploy" } as restate.VirtualObjectDefinition<"SelfDeploy", unknown>, ctx.key) as unknown as
      Record<typeof handler, (input: unknown, opts: restate.SendOpts<unknown>) => void>;
    self[handler](input, restate.rpc.sendOpts({ delay, headers: { "self-deploy-id": record.deployId } }));
  }
  function current(ctx: restate.ObjectContext, record: SelfDeployRecord | null, phase: SelfDeployPhase): record is SelfDeployRecord {
    return record?.phase === phase && ctx.request().headers.get("self-deploy-id") === record.deployId;
  }
  async function finish(ctx: restate.ObjectContext, record: SelfDeployRecord, phase: "succeeded" | "failed" | "cancelled", reason: SelfDeployRecord["reason"] = null) {
    const next = { ...record, phase, reason, finishedAt: await ctx.date.now() };
    write(ctx, next);
    await ctx.run("clear hold", () => deps.setHold(false));
    await ctx.run("record outcome", () => deps.onOutcome(next));
  }
  async function start(ctx: restate.ObjectContext, input: z.infer<typeof startSchema>): Promise<SelfDeployStartResult> {
    const existing = await read(ctx);
    if (active(existing)) return { deployId: existing.deployId, commit: existing.target.commit, image: existing.target.image, alreadyActive: true };
    const found = await ctx.run("find target", async (): Promise<SelfDeployRecord["target"] | { reason: "not-configured" | "head-unknown" | "image-not-published" }> => {
      const config = deps.config();
      if (!config.flyDeployToken || !config.flyOrchestratorApp || !config.selfDeployTarget) return { reason: "not-configured" };
      const commit = await deps.head(config.selfDeployTarget, input.branch);
      if (!commit) return { reason: "head-unknown" };
      const source = config.kgSourceRepo ? "built" : "published";
      const image = source === "built" ? `registry.fly.io/${ctx.key}:deploy-${commit.slice(0, 7)}`
        : `registry.fly.io/${config.imageApp ?? "builddown-orchestrator-image"}:${input.branch}-${commit.slice(0, 7)}`;
      if (source === "published") {
        const status = await deps.registryHead(image, config.flyDeployToken);
        if (status < 200 || status >= 300) {
          ctx.console.warn(`[self-deploy] image-not-published HTTP ${status}`);
          return { reason: "image-not-published" };
        }
      }
      return { branch: input.branch, commit, image, source };
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
    const policy = await ctx.run("apply policy", async () => {
      if (!await deps.applyFlyToml()) return "image";
      return deps.config().imageApp ? "refused" : "toml";
    });
    // Outside the retried effect so a partially applied multi-machine update logs this only once.
    if (policy === "refused") ctx.console.warn("[self-deploy] deploy_apply_fly_toml refused: control plane owns machine config");
    const accepted = await ctx.run("apply image", async () => {
      const config = deps.config();
      const token = config.flyDeployToken!;
      try {
        // Reread inside the same retried effect: an accepted update may have killed this process.
        const machines = await deps.fly.listMachines(token, ctx.key);
        const fresh = await Promise.all(machines.map(m => deps.fly.getMachine(token, ctx.key, m.id)));
        if (fresh.length > 0 && fresh.every(m => m.config.image === record.target.image)) return true;
        if (record.target.source === "built") {
          const args = deployArgs({ app: ctx.key, sourceCommit: record.target.commit, sourceRepo: `${config.selfDeployTarget!.owner}/${config.selfDeployTarget!.repo}`, sourceBranch: record.target.branch, kgSourceRepo: config.kgSourceRepo!, kgToken: await deps.kgToken() });
          await deps.flyctl(record, [...args, "--build-only", "--push", "--image-label", `deploy-${record.target.commit.slice(0, 7)}`], token);
        }
        if (policy === "toml") await deps.flyctl(record, ["deploy", "--image", record.target.image, "--detach", "--app", ctx.key], token);
        else for (const machine of fresh) {
          if (machine.config.image !== record.target.image) await deps.fly.updateMachine(token, ctx.key, machine.id, { ...machine.config, image: record.target.image });
        }
        return true;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if ((status && status >= 400 && status < 500) || (error instanceof Error && /\(4\d\d\)/.test(error.message))) return false;
        throw error;
      }
    });
    if (!accepted) await finish(ctx, record, "failed", "apply-failed");
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
    if (!active(record)) return { cancelled: false, reason: "no-active-deploy" };
    if (record.phase !== "draining") return { cancelled: false, reason: "too-late" };
    await finish(ctx, record, "cancelled");
    return { cancelled: true };
  }
  return restate.object({ name: "SelfDeploy", handlers: {
    start: restate.handlers.object.exclusive({ input: serde.zod(startSchema) }, start),
    checkDrain: restate.handlers.object.exclusive({ ingressPrivate: true }, checkDrain),
    apply: restate.handlers.object.exclusive({ ingressPrivate: true }, apply),
    verify: restate.handlers.object.exclusive({ ingressPrivate: true, input: serde.zod(z.object({ attempt: z.number().int().min(1).max(5) }).strict()) }, verify),
    cancel: restate.handlers.object.exclusive({ input: serde.zod(z.object({ requestedBy: requester }).strict()) }, cancel),
    status: restate.handlers.object.shared(read),
  } });
}

/** Registry authentication is performed by the effect's caller; only the status is journaled. */
export async function publishedImageManifestHead(image: string, token: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const ref = /^registry\.fly\.io\/([^:]+):(.+)$/.exec(image);
  if (!ref) throw new Error("Invalid Fly image reference");
  const response = await fetchImpl(`https://registry.fly.io/v2/${ref[1]}/manifests/${ref[2]}`, {
    method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
  });
  return response.status;
}
