/**
 * `KgSidecarHealth` — a Virtual Object, one key (`sidecar`), that re-probes the KG sidecar while it is
 * marked unavailable (AII-1527). The poll loop is the tick (`checkKgSidecarHealth`): each cycle sends
 * one `check`. The exclusive handler queues a second `check` behind the first, so two probes from this
 * object never run at once, and the probe result is in the invocation's journal. Recovery sends are journaled in a named step.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import { clearKgRecoveryNotice, hasKgRecoveryNotice, postKgRecoveryNotice } from "../deploy-notify.js";
import { isDeployHeld } from "../deploy-hold.js";
import { isRemoteKgStore } from "../kg-sidecar.js";
import type { SidecarHealth } from "../kg-provider.js";
import { SidecarMemoryProvider, getKgMemoryProvider, isKgUnavailable, probeWithTimeout } from "../kg-provider.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { restateCanServe } from "./status.js";

export interface KgSidecarHealthDeps {
  /** A plain function (no ctx). Resolves `null` when there is nothing to probe. */
  probe(): Promise<SidecarHealth | null>;
  notifyRecovery?: () => Promise<void>;
  clearRecovery?: () => void;
}

export const KG_SIDECAR_HEALTH_KEY = "sidecar";

export function createKgSidecarHealth(deps: KgSidecarHealthDeps) {
  return restate.object({
    name: "KgSidecarHealth",
    handlers: {
      check: restate.handlers.object.exclusive(
        async (ctx: ObjectContext): Promise<SidecarHealth | null> => {
          const health = await ctx.run("probe", () => deps.probe());
          if (health && health.lastError === null) {
            try {
              await ctx.run("notify-recovery", () => (deps.notifyRecovery ?? postKgRecoveryNotice)(), {
                maxRetryAttempts: 3,
              });
            } catch (err) {
              // Only exhausted delivery failures may abandon the notice. Runtime
              // suspension and invocation cancellation must unwind unchanged.
              if (!(err instanceof restate.TerminalError) || err.code === 409) throw err;
              await ctx.run("discard-recovery", () => {
                (deps.clearRecovery ?? clearKgRecoveryNotice)();
                console.warn(`[deploy-notify] KG recovery notice failed: ${err instanceof Error ? err.message : String(err)}`);
              }, { maxRetryAttempts: 3 });
            }
          }
          return health;
        },
      ),
    },
  });
}

export type KgSidecarHealthDefinition = ReturnType<typeof createKgSidecarHealth>;

/** Recovery and deploy warm-up must not wake a billed remote store. */
export function probeKgSidecarAfterBoot(provider: SidecarMemoryProvider, timeoutMs?: number): Promise<SidecarHealth> {
  return probeWithTimeout(provider, timeoutMs, isRemoteKgStore() ? "list-only" : "full");
}

/**
 * The production probe. Does nothing (and sends no sidecar request) once the sidecar is no longer
 * marked unavailable, so a `check` queued behind a recovery is a no-op. `probeWithTimeout` never throws.
 */
export async function probeKgSidecarIfUnavailable(): Promise<SidecarHealth | null> {
  if (!isKgUnavailable() && !hasKgRecoveryNotice()) return null;
  const provider = getKgMemoryProvider();
  if (!(provider instanceof SidecarMemoryProvider)) return null;
  return probeKgSidecarAfterBoot(provider);
}

// --- the poll-loop caller -------------------------------------------------------------------------

export interface CheckKgSidecarHealthDeps {
  restateReady?: () => boolean;
  deployHeld?: () => boolean;
  unavailable?: () => boolean;
  fetchImpl?: typeof fetch;
}

const SEND_TIMEOUT_MS = 10_000;

/**
 * While the sidecar is marked unavailable, sends one `KgSidecarHealth.check` (one-way: the poll does
 * not wait for the probe). Makes no call during a deploy hold, while Restate is not ready, or when the
 * sidecar is available. A failed call logs one line and never throws.
 */
export async function checkKgSidecarHealth(deps: CheckKgSidecarHealthDeps = {}): Promise<void> {
  if ((deps.deployHeld ?? isDeployHeld)()) return;
  const ready = deps.restateReady ?? restateCanServe;
  if (!ready()) return;
  if (!(deps.unavailable ?? (() => isKgUnavailable() || hasKgRecoveryNotice()))()) return;
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      `${RESTATE_INGRESS_BASE_URL}/KgSidecarHealth/${KG_SIDECAR_HEALTH_KEY}/check/send`,
      { method: "POST", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
    if (!response.ok) console.warn(`[kg-sidecar-health] check answered HTTP ${response.status}`);
  } catch (err) {
    console.warn(`[kg-sidecar-health] check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
