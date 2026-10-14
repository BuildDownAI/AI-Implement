/**
 * `ChatGptPlanAccount` — a Virtual Object, one per account profile id, that is the only place a hosted
 * ChatGPT plan refresh token is renewed (AII-1200). OpenAI rotates the refresh token on every refresh, so
 * refreshes of one session must be serialized: the exclusive `refresh` handler does that.
 *
 * Trust boundary: the record lives encrypted in the session store (`readPlanRecord` / `writePlanRecord`).
 * Plaintext exists only inside the one `refresh` `ctx.run` closure, which returns `{ outcome, nextAt }` and
 * nothing else. Object state holds `{ lastOutcome, lastAttemptAt, nextAt }`. No token reaches the journal,
 * state, a log line, or a thrown error.
 *
 * The `ctx.run` uses `maxRetryAttempts: 1` (ADR 025 amendment): a retried refresh with an already-rotated
 * token returns `refresh_token_reused` and ends the session. A crash between OpenAI's rotation and the store
 * write still loses the session; that window is accepted and the profile then needs a new sign-in.
 *
 * Outcomes beyond the issue's table: a corrupt or unparsable record maps to `reauth_required`; an unavailable
 * key or store fault maps to `transient`.
 *
 * Scheduling: every run records `nextAt` in state and sends a delayed `refresh` carrying `scheduledFor: nextAt`.
 * A scheduled run whose `scheduledFor` no longer matches state is a superseded timer (a `requested` run
 * re-armed the schedule) and does nothing, so timers do not multiply.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import {
  parseChatGptPlanRecord,
  refreshChatGptPlanRecord,
  serializeChatGptPlanRecord,
  shouldRefresh,
  type ChatGptPlanRecordV1,
} from "../chatgpt-plan-token.js";
import { getDb } from "../dedup.js";
import { createModelSessionStore, type ModelSessionStore } from "../model-session-store.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type ChatGptPlanOutcome = "fresh" | "refreshed" | "reauth_required" | "invalid_client" | "transient" | "missing";

export interface ChatGptPlanRefreshResult {
  outcome: ChatGptPlanOutcome;
  /** Epoch ms of the next scheduled refresh; null when nothing is scheduled. */
  nextAt: number | null;
}

interface PlanAccountState {
  lastOutcome: ChatGptPlanOutcome;
  lastAttemptAt: number;
  nextAt: number | null;
}

export interface ChatGptPlanAccountDeps {
  store: ModelSessionStore;
  fetch: typeof fetch;
  now: () => number;
}

const STATE_KEY = "state";
const REFRESH_WINDOW_MS = 10 * 60_000;
const MIN_DELAY_MS = 60_000;
const TRANSIENT_RETRY_MS = 2 * 60_000;

const refreshSchema = z
  .object({ reason: z.enum(["scheduled", "requested"]), scheduledFor: z.number().optional() })
  .strict();
type RefreshInput = z.infer<typeof refreshSchema>;

/** `min(earliestRefreshAt, expiry - 10 min)`, never earlier than 60 s from now. */
export function planNextAt(record: ChatGptPlanRecordV1, now: number): number {
  const byExpiry = record.accessTokenExpiresAt - REFRESH_WINDOW_MS;
  const due = record.earliestRefreshAt === null ? byExpiry : Math.min(record.earliestRefreshAt, byExpiry);
  return Math.max(due, now + MIN_DELAY_MS);
}

/** Fail-closed store for a deployment with no provisioned session key: nothing can be read or written. */
function unprovisionedStore(): ModelSessionStore {
  return createModelSessionStore({
    keys: { current: () => undefined, get: () => undefined },
    verifyOwner: () => false,
    authorizeOperator: () => false,
    db: () => getDb(), // resolved per call, so importing this module opens no database
  });
}

function readRecord(store: ModelSessionStore, profileId: string):
  | { kind: "ok"; record: ChatGptPlanRecordV1; sequence: number }
  | { kind: "outcome"; outcome: ChatGptPlanOutcome } {
  const read = store.readPlanRecord(profileId);
  if (!read.ok) {
    if (read.reason === "no_state") return { kind: "outcome", outcome: "missing" };
    if (read.category === "authentication_required" || read.reason === "write_failed") {
      return { kind: "outcome", outcome: "transient" };
    }
    return { kind: "outcome", outcome: "reauth_required" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.sessionData);
  } catch {
    return { kind: "outcome", outcome: "reauth_required" };
  }
  const parsed = parseChatGptPlanRecord(raw);
  if (!parsed.ok) return { kind: "outcome", outcome: "reauth_required" };
  return { kind: "ok", record: parsed.value, sequence: read.stateSequence };
}

/** The whole plaintext step. Returns no token; never throws. */
async function refreshStep(deps: ChatGptPlanAccountDeps, profileId: string): Promise<ChatGptPlanRefreshResult> {
  try {
    const now = deps.now();
    const current = readRecord(deps.store, profileId);
    if (current.kind === "outcome") {
      return { outcome: current.outcome, nextAt: current.outcome === "transient" ? now + TRANSIENT_RETRY_MS : null };
    }
    if (!shouldRefresh(current.record, now, REFRESH_WINDOW_MS)) {
      return { outcome: "fresh", nextAt: planNextAt(current.record, now) };
    }
    const result = await refreshChatGptPlanRecord(current.record, { fetch: deps.fetch, now: deps.now });
    if (!result.ok) {
      if (result.failure === "transient") return { outcome: "transient", nextAt: deps.now() + TRANSIENT_RETRY_MS };
      return { outcome: result.failure, nextAt: null };
    }
    const written = deps.store.writePlanRecord({
      profileId,
      expectedSequence: current.sequence,
      sessionData: serializeChatGptPlanRecord(result.record),
    });
    if (written.ok) return { outcome: "refreshed", nextAt: planNextAt(result.record, deps.now()) };
    if (written.reason === "stale_sequence") {
      // Another write won the compare-and-set: use its record.
      const winner = readRecord(deps.store, profileId);
      if (winner.kind === "ok") return { outcome: "fresh", nextAt: planNextAt(winner.record, deps.now()) };
    }
    // The rotated token could not be saved; nothing more can be done here, so retry like a transient fault.
    return { outcome: "transient", nextAt: deps.now() + TRANSIENT_RETRY_MS };
  } catch {
    return { outcome: "transient", nextAt: deps.now() + TRANSIENT_RETRY_MS };
  }
}

export function createChatGptPlanAccount(deps: ChatGptPlanAccountDeps) {
  async function refresh(ctx: ObjectContext, input: RefreshInput): Promise<ChatGptPlanRefreshResult> {
    const previous = await ctx.get<PlanAccountState>(STATE_KEY);
    if (input.reason === "scheduled" && input.scheduledFor !== undefined && input.scheduledFor !== (previous?.nextAt ?? null)) {
      // A later run re-armed the schedule; this timer is superseded.
      return { outcome: previous?.lastOutcome ?? "fresh", nextAt: previous?.nextAt ?? null };
    }
    const result = await ctx.run("refresh", () => refreshStep(deps, ctx.key), { maxRetryAttempts: 1 });
    const attemptedAt = await ctx.date.now();
    ctx.set<PlanAccountState>(STATE_KEY, { lastOutcome: result.outcome, lastAttemptAt: attemptedAt, nextAt: result.nextAt });
    if (result.nextAt !== null) {
      const self = ctx.objectSendClient({ name: "ChatGptPlanAccount" } as restate.VirtualObjectDefinition<"ChatGptPlanAccount", unknown>, ctx.key) as unknown as {
        refresh(input: RefreshInput, opts: restate.SendOpts<RefreshInput>): void;
      };
      self.refresh(
        { reason: "scheduled", scheduledFor: result.nextAt },
        restate.rpc.sendOpts({ delay: Math.max(0, result.nextAt - attemptedAt) }),
      );
    }
    ctx.console.info(`[ChatGptPlanAccount] ${ctx.key} ${result.outcome} next=${result.nextAt === null ? "none" : new Date(result.nextAt).toISOString()}`);
    return result;
  }

  return restate.object({
    name: "ChatGptPlanAccount",
    handlers: {
      refresh: restate.handlers.object.exclusive({ input: serde.zod(refreshSchema) }, refresh),
    },
  });
}

export type ChatGptPlanAccountDefinition = ReturnType<typeof createChatGptPlanAccount>;

/**
 * The bound object. No session key provider exists yet (AII-1203/1204 provision one), so the production store
 * fails closed: an account with no readable record answers `missing`, one with an unreadable key `transient`.
 */
export const chatGptPlanAccount: ChatGptPlanAccountDefinition = createChatGptPlanAccount({
  store: unprovisionedStore(),
  fetch: (...args) => fetch(...args),
  now: Date.now,
});

/** Asks the account's object for a refresh now. Used by the import command and the hosted checkout. */
export async function requestChatGptPlanRefresh(
  profileId: string,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const ingress = restateClients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
  });
  await ingress
    .objectSendClient<ChatGptPlanAccountDefinition>({ name: "ChatGptPlanAccount" }, profileId)
    .refresh({ reason: "requested" });
}
