/**
 * `Operator` — a Virtual Object, one per OAuth client id, that is the refresh-token
 * authority for the MCP human identity path (AII-709). It replaces
 * `SqliteRefreshAuthority` (src/mcp-oauth.ts, AII-707) as the default: an exclusive
 * `refresh` handler serializes concurrent refreshes of the same family so two Claude
 * sessions sharing one credential store no longer revoke each other, and applies one
 * bounded grace window instead of treating every re-presentation of a just-rotated
 * token as theft.
 *
 * Trust boundary: this object holds refresh-token *hashes only*. Restate state, journals and
 * handler inputs/outputs never contain a raw refresh token (AII-1287): the admin-only Restate
 * UI proxy (ADR 040) can read state and journals, so a raw token there would be readable.
 * The orchestrator derives the next token outside Restate (`deriveNextRefreshToken`: an HMAC of
 * the presented token under a key from HKDF over `GITHUB_APP_PRIVATE_KEY`, which never reaches
 * the sidecar) and sends only `{ presentedHash, nextHash }`. Two concurrent callers presenting
 * the same token therefore compute the same next token independently; the exclusive handler
 * only has to agree on its hash. `ctx.rand` is not used — it is seeded from the invocation id,
 * which is not secret.
 *
 * Access tokens stay verified in SQLite (`mcp_tokens`, `verifyMcpToken`) — this object
 * only tracks refresh-token family state.
 */
import crypto from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { getDb } from "../dedup.js";
import { getEffectiveAllowlist, matchAccessEntryOrOrgClaim } from "../access-entries.js";
import { recordAuthEvent, resolveClientPath, type AuthEventCause } from "../mcp-auth-events.js";
import type { DescribeOutcome, IssueInput, IssueOutcome, RefreshAuthority, RefreshInput, RefreshOutcome } from "../mcp-identity.js";
import { RESTATE_INGRESS_BIND_ADDRESS } from "./server.js";
import { isDeployHeld } from "../deploy-hold.js";

/** One tick past this and a presentation of the previous (just-rotated-away) hash is treated as replay. */
export const GRACE_MS = 30_000;

/** Refresh invocation bound (AII-728): a hung ingress call must not hang a token refresh forever. */
const INVOKE_TIMEOUT_MS = 10_000;

// Mirrors mcp-oauth.ts's own MCP_REFRESH_TOKEN_TTL_MS (30 days). Duplicated rather than
// imported to keep the dependency direction one-way: mcp-oauth.ts imports
// RestateRefreshAuthority from this module, so this module must not import mcp-oauth.ts.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Fixed domain-separation labels: changing either changes every derived token. */
const REFRESH_KEY_SALT = "ai-implement:mcp-refresh-token:salt:v1";
const REFRESH_KEY_INFO = "ai-implement:mcp-refresh-token:hmac-key:v1";

/**
 * The next refresh token for a family: hex HMAC-SHA256 of the presented token under a key
 * HKDF-derived from the GitHub App private key. Deterministic, so concurrent refreshes of the
 * same presented token converge without any raw token crossing Restate. Orchestrator process only.
 */
export function deriveNextRefreshToken(presented: string, secret: string): string {
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, REFRESH_KEY_SALT, REFRESH_KEY_INFO, 32));
  return crypto.createHmac("sha256", key).update(presented).digest("hex");
}

export interface FamilyState {
  currentHash: string;
  previousHash: string | null;
  rotatedAt: number;
  expiresAt: number;
}

interface IssueRequest {
  email: string;
  sub: string;
  provider: string;
  hash: string;
  expiresAt: number;
}

interface RefreshRequest {
  presentedHash: string;
  /** Hash of the token the orchestrator derived from the presented one (`deriveNextRefreshToken`). */
  nextHash: string;
  /**
   * Test-only seam (AII-727): when set, the handler durably sleeps this many ms — still
   * holding the exclusive lock — before deciding. Proves a concurrent `describe` (shared)
   * answers without waiting on it. Omitted on every production call path (issue/rotate never
   * set it), so it is inert there: it never changes decideRefresh's branch or the inputs to
   * it, and the alwaysReplay-vs-disableRetries equivalence check in
   * operator-object.restate.test.ts never exercises it.
   */
  sleepMs?: number;
}

type RefreshHandlerResult =
  | { status: "ok"; expiresAt: number; email: string; sub: string; provider: string }
  | { status: "replay" }
  | { status: "expired" }
  | { status: "unavailable" };

interface DescribeResult {
  email: string | null;
  rotatedAt: number | null;
  expiresAt: number | null;
}

/**
 * The pre-rotation identity read (AII-718): `sub` and `provider` alongside `email` so
 * `RestateRefreshAuthority.rotate` can run the allowlist check before calling `refresh`,
 * without adding a hash field that would let a read leak what only `refresh` should mint.
 * Kept separate from `describe` (AII-714, backing `get_session_identity`) rather than
 * extending it, so `describe`'s response shape stays exactly what that caller already relies on.
 */
interface IdentityResult {
  email: string | null;
  sub: string | null;
  provider: string | null;
  expiresAt: number | null;
}

/**
 * The state-table branch, as a pure function of state and time (docs/restate.md's
 * "operator rule": state-table branches are unit-tested with the Restate client
 * injected as a fake, so the exact grace-window boundary is testable without a real
 * 30-second wait against a live container).
 */
export type RefreshDecision =
  | { kind: "rotate" }
  | { kind: "concurrent" }
  | { kind: "replay"; clear: boolean }
  | { kind: "expired" };

export function decideRefresh(family: FamilyState | null, presentedHash: string, now: number): RefreshDecision {
  if (!family) {
    // Unknown hash (no family issued, or already cleared): nothing to revoke.
    return { kind: "replay", clear: false };
  }
  if (now > family.expiresAt) {
    return { kind: "expired" };
  }
  if (presentedHash === family.currentHash) {
    return { kind: "rotate" };
  }
  if (family.previousHash !== null && presentedHash === family.previousHash) {
    // Inclusive bound, per the issue: exactly GRACE_MS since rotation still counts.
    return now - family.rotatedAt <= GRACE_MS ? { kind: "concurrent" } : { kind: "replay", clear: true };
  }
  // Unknown hash: nothing to revoke, so a forged or stale presentation must not wipe a
  // legitimate live family out from under a concurrent, correct caller.
  return { kind: "replay", clear: false };
}

async function issue(ctx: ObjectContext, request: IssueRequest): Promise<void> {
  const rotatedAt = await ctx.date.now();
  ctx.set<string>("email", request.email);
  ctx.set<string>("sub", request.sub);
  ctx.set<string>("provider", request.provider);
  ctx.set<FamilyState>("family", {
    currentHash: request.hash,
    previousHash: null,
    rotatedAt,
    expiresAt: request.expiresAt,
  });
}

async function refresh(ctx: ObjectContext, request: RefreshRequest): Promise<RefreshHandlerResult> {
  if (request.sleepMs !== undefined) {
    await ctx.sleep(request.sleepMs);
  }
  const family = await ctx.get<FamilyState>("family");
  const now = await ctx.date.now();
  const decision = decideRefresh(family, request.presentedHash, now);

  switch (decision.kind) {
    case "expired":
      ctx.clearAll();
      return { status: "expired" };
    case "replay":
      if (decision.clear) {
        ctx.clearAll();
      }
      return { status: "replay" };
    case "concurrent": {
      // family is non-null here: decideRefresh only returns "concurrent" when a
      // previous-hash match was found, which requires a family to compare against.
      const f = family as FamilyState;
      // The caller converges only when it derived the very token already rotated in. A
      // mismatch (a legacy family whose current token the old code minted, or a key change
      // inside the grace window) is not theft: answer unavailable and change nothing.
      if (request.nextHash !== f.currentHash) {
        return { status: "unavailable" };
      }
      const [email, sub, provider] = await Promise.all([
        ctx.get<string>("email"),
        ctx.get<string>("sub"),
        ctx.get<string>("provider"),
      ]);
      return { status: "ok", expiresAt: f.expiresAt, email: email ?? "", sub: sub ?? "", provider: provider ?? "" };
    }
    case "rotate": {
      const f = family as FamilyState;
      const [email, sub, provider] = await Promise.all([
        ctx.get<string>("email"),
        ctx.get<string>("sub"),
        ctx.get<string>("provider"),
      ]);
      const expiresAt = now + REFRESH_TOKEN_TTL_MS;
      ctx.set<FamilyState>("family", {
        currentHash: request.nextHash,
        previousHash: f.currentHash,
        rotatedAt: now,
        expiresAt,
      });
      return { status: "ok", expiresAt, email: email ?? "", sub: sub ?? "", provider: provider ?? "" };
    }
  }
}

/**
 * One-time scrub of the raw `currentToken` the pre-AII-1287 code kept in family state. Removes
 * only a non-empty `currentToken`; every other field is left as it was. Exclusive, so it cannot
 * interleave with a `refresh` on the same key. Returns whether it removed anything.
 */
async function dropLegacyToken(ctx: ObjectContext): Promise<boolean> {
  const family = await ctx.get<FamilyState & { currentToken?: string }>("family");
  if (!family || !family.currentToken) {
    return false;
  }
  const { currentToken: _dropped, ...rest } = family;
  ctx.set<FamilyState>("family", rest);
  return true;
}

async function revoke(ctx: ObjectContext): Promise<void> {
  ctx.clearAll();
}

async function describe(ctx: ObjectSharedContext): Promise<DescribeResult> {
  const email = await ctx.get<string>("email");
  const family = await ctx.get<FamilyState>("family");
  return {
    email: email ?? null,
    rotatedAt: family?.rotatedAt ?? null,
    expiresAt: family?.expiresAt ?? null,
  };
}

async function identity(ctx: ObjectSharedContext): Promise<IdentityResult> {
  const [email, sub, provider, family] = await Promise.all([
    ctx.get<string>("email"),
    ctx.get<string>("sub"),
    ctx.get<string>("provider"),
    ctx.get<FamilyState>("family"),
  ]);
  return {
    email: email ?? null,
    sub: sub ?? null,
    provider: provider ?? null,
    expiresAt: family?.expiresAt ?? null,
  };
}

export const operatorObject = restate.object({
  name: "Operator",
  handlers: {
    issue,
    refresh,
    dropLegacyToken,
    revoke,
    describe: restate.handlers.object.shared(describe),
    identity: restate.handlers.object.shared(identity),
  },
});

// ---------- RestateRefreshAuthority: the ingress-client seam implementation ----------

export interface RestateRefreshAuthorityOptions {
  /** Defaults to the real ingress (127.0.0.1:8081, AII-627). Overridable for tests. */
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Shared deploy drain admission check; injectable for deterministic tests. */
  permitsExternalCall?: () => boolean;
  /** Secret the next-refresh-token key derives from. Defaults to `GITHUB_APP_PRIVATE_KEY`; overridable for tests. */
  refreshKeySecret?: string;
  /** The access token's TTL, minted here in SQLite alongside a successful rotation. */
  accessTokenTtlMs: number;
}

/**
 * Calls the `Operator` object through the Restate ingress. Never throws: a connection
 * failure or a non-2xx response both resolve to `{ status: "unavailable" }`, matching
 * decision 4 of AII-687 (503 when Restate is down, no fallback authority).
 */
export class RestateRefreshAuthority implements RefreshAuthority {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly accessTokenTtlMs: number;
  private readonly permitsExternalCall: () => boolean;
  private readonly refreshKeySecret: string | undefined;

  constructor(options: RestateRefreshAuthorityOptions) {
    this.baseUrl = options.ingressBaseUrl ?? `http://${RESTATE_INGRESS_BIND_ADDRESS}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessTokenTtlMs = options.accessTokenTtlMs;
    this.refreshKeySecret = options.refreshKeySecret;
    this.permitsExternalCall = options.permitsExternalCall ?? (() => !isDeployHeld());
  }

  private async invoke<T>(clientId: string, handler: string, body: unknown): Promise<T | "unavailable"> {
    if (!this.permitsExternalCall()) return "unavailable";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/Operator/${encodeURIComponent(clientId)}/${handler}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
      });
    } catch {
      return "unavailable";
    }
    if (!response.ok) {
      return "unavailable";
    }
    // A void handler (issue, revoke) answers with an empty body — that is success, not a
    // parse failure. Anything non-empty is expected to be JSON; a body that isn't maps to
    // unavailable exactly like a connection failure, rather than throwing.
    const text = await response.text();
    if (text === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return "unavailable";
    }
  }

  async issue(input: IssueInput): Promise<IssueOutcome> {
    const refreshToken = `${crypto.randomBytes(32).toString("hex")}`;
    const hash = sha256(refreshToken);
    const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;
    const result = await this.invoke<unknown>(input.clientId, "issue", {
      email: input.email,
      sub: input.sub,
      provider: input.provider,
      hash,
      expiresAt,
    });
    if (result === "unavailable") {
      return { status: "unavailable" };
    }
    return { status: "ok", refreshToken };
  }

  /**
   * Ordered so nothing durable changes before every local check has passed (AII-718): the
   * identity read (`identity`, shared, no lock) comes first, then the allowlist re-check,
   * and only then the exclusive `refresh` handler — which is the one call that rotates the
   * family — followed by the SQLite insert. The previous order rotated first and read the
   * allowlist after; if the allowlist read or the insert then failed, the caller got a 503
   * having already lost its current refresh token, and its retry (presenting the
   * now-previous hash) landed outside `GRACE_MS` often enough to be treated as replay and
   * wipe the family. Reversing the order means a failed check leaves the family exactly as
   * it was, so a retry presents the same hash and succeeds normally.
   */
  async rotate(input: RefreshInput): Promise<RefreshOutcome> {
    const start = Date.now();
    const clientId = input.clientId;

    // One event per call, on every return path — mirrors SqliteRefreshAuthority.rotate so
    // AII-708's refresh measurement stays populated under the new default authority.
    const emit = (cause: AuthEventCause, identity?: { email: string }): void => {
      recordAuthEvent({
        at: Date.now(),
        kind: "refresh",
        cause,
        clientId,
        clientPath: resolveClientPath(clientId),
        identityKind: identity ? "human" : null,
        email: identity?.email ?? null,
        // One object per client id (AII-709): the family this seam names is the whole
        // client's refresh state, so the client id doubles as the family id.
        familyId: clientId,
        latencyMs: Date.now() - start,
      });
    };

    // Step 1: read identity through the shared, non-mutating handler. Nothing durable
    // changes yet — a Restate outage here mutates nothing.
    const who = await this.invoke<IdentityResult>(clientId, "identity", {});
    if (who === "unavailable") {
      emit("unavailable");
      return { status: "unavailable", cause: "restate" };
    }
    if (who.email === null && who.sub === null && who.provider === null) {
      // No family was ever issued for this client id, or it was already fully revoked
      // (`identity` returns every field null in both cases). decideRefresh's own "no
      // family" branch treats this as replay rather than denial, since there is no
      // identity to deny or family to revoke; check for it here too so an unknown or
      // garbage client id maps to the same outcome the pre-AII-718 refresh-first order
      // produced, instead of a spurious "denied" plus a revoke call against nothing.
      emit("replay");
      return { status: "replay" };
    }

    // Step 2: allowlist re-check on that identity (fail-closed: a removed user must not
    // outlive their access token). AII-687's rule: the allowlist re-check stays the
    // revocation path — mirrored from SqliteRefreshAuthority.rotate. Still nothing durable
    // changed — an unreadable list or a denial both leave the family untouched.
    const allowlist = getEffectiveAllowlist();
    const knownIdentity = who.email ? { email: who.email } : undefined;
    if (!allowlist) {
      // Do NOT revoke here — a transient read failure is not a removal.
      console.error("[mcp-oauth] refresh deferred: the access list could not be loaded");
      emit("unavailable", knownIdentity);
      return { status: "unavailable", cause: "allowlist" };
    }
    if (!matchAccessEntryOrOrgClaim({ email: who.email, sub: who.sub ?? "", provider: who.provider ?? "" }, allowlist.entries)) {
      await this.invoke(clientId, "revoke", {});
      console.warn(`[mcp-oauth] refresh denied: ${who.email ?? "unknown identity"} no longer on allowlist`);
      emit("allowlist", knownIdentity);
      return { status: "denied", description: "Identity no longer authorized" };
    }

    // Step 3: only now, with every local check passed, rotate the family. This is the one
    // durable write in the whole call — the SQLite insert just below is the one remaining
    // fallible step after it, and a SQLITE_BUSY there is covered by the GRACE_MS window (a
    // client retry inside it presents the pre-rotation hash and gets the same pair back,
    // via decideRefresh's "concurrent" branch, rather than being treated as replay).
    const secret = this.refreshKeySecret ?? process.env.GITHUB_APP_PRIVATE_KEY;
    if (!secret) {
      console.error("[mcp-oauth] refresh unavailable: no secret to derive the next refresh token from");
      emit("unavailable");
      return { status: "unavailable", cause: "restate" };
    }
    const presentedHash = sha256(input.refreshToken);
    const nextRefreshToken = deriveNextRefreshToken(input.refreshToken, secret);
    const result = await this.invoke<RefreshHandlerResult>(clientId, "refresh", {
      presentedHash,
      nextHash: sha256(nextRefreshToken),
    });
    if (result === "unavailable" || result.status === "unavailable") {
      emit("unavailable");
      return { status: "unavailable", cause: "restate" };
    }
    if (result.status === "replay") {
      emit("replay");
      return { status: "replay" };
    }
    if (result.status === "expired") {
      emit("expired");
      return { status: "expired" };
    }

    const now = Date.now();
    const accessToken = crypto.randomBytes(32).toString("hex");
    getDb()
      .prepare(
        "INSERT INTO mcp_tokens (token, email, sub, provider, created_at, expires_at, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(accessToken, result.email, result.sub, result.provider, now, now + this.accessTokenTtlMs, clientId);

    emit("ok", { email: result.email });
    return {
      status: "ok",
      accessToken,
      refreshToken: nextRefreshToken,
      expiresInSeconds: Math.floor(this.accessTokenTtlMs / 1000),
    };
  }

  async revokeFamily(clientId: string): Promise<void> {
    // One object per client id (AII-709) — the "family" this seam names is the whole
    // client's refresh state, so revoking it is the object's own `revoke` handler.
    await this.invoke(clientId, "revoke", {});
  }

  /** Backs `get_session_identity`'s `refresh` field (AII-714) — reads the object's own state via its shared `describe` handler, minting nothing and rotating nothing. */
  async describe(clientId: string): Promise<DescribeOutcome> {
    const result = await this.invoke<DescribeResult>(clientId, "describe", {});
    if (result === "unavailable") {
      return { status: "unavailable" };
    }
    return { status: "ok", expiresAt: result.expiresAt };
  }
}
