/**
 * `Operator` — a Virtual Object, one per OAuth client id, that is the refresh-token
 * authority for the MCP human identity path (AII-709). It replaces
 * `SqliteRefreshAuthority` (src/mcp-oauth.ts, AII-707) as the default: an exclusive
 * `refresh` handler serializes concurrent refreshes of the same family so two Claude
 * sessions sharing one credential store no longer revoke each other, and applies one
 * bounded grace window instead of treating every re-presentation of a just-rotated
 * token as theft.
 *
 * Trust boundary: this object is reachable only through the localhost ingress
 * (127.0.0.1:8081, AII-627). Only a token *hash* ever crosses that ingress inbound —
 * the ingress journals request bodies, and a journaled raw token would outlive its
 * rotation. `refresh` itself mints the next raw token (via `ctx.rand.uuidv4()`, so
 * concurrent callers converge on the identical value once the exclusive handler has
 * serialized them) and returns it — that is unavoidable, since a caller cannot hand
 * back a bearer secret it never received without the object producing it — but no raw
 * token is ever accepted as *input*.
 *
 * Access tokens stay verified in SQLite (`mcp_tokens`, `verifyMcpToken`) — this object
 * only tracks refresh-token family state.
 */
import crypto from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { getDb } from "../dedup.js";
import type { IssueInput, IssueOutcome, RefreshAuthority, RefreshInput, RefreshOutcome } from "../mcp-identity.js";
import { RESTATE_INGRESS_BIND_ADDRESS } from "./server.js";

/** One tick past this and a presentation of the previous (just-rotated-away) hash is treated as replay. */
export const GRACE_MS = 30_000;

// Mirrors mcp-oauth.ts's own MCP_REFRESH_TOKEN_TTL_MS (30 days). Duplicated rather than
// imported to keep the dependency direction one-way: mcp-oauth.ts imports
// RestateRefreshAuthority from this module, so this module must not import mcp-oauth.ts.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export interface FamilyState {
  currentHash: string;
  /** The raw value hashing to `currentHash`, kept only so a concurrent refresh presenting
   *  the previous hash within GRACE_MS can be handed back the same pair (see module doc). */
  currentToken: string;
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
}

type RefreshHandlerResult =
  | { status: "ok"; token: string; expiresAt: number; email: string; sub: string; provider: string }
  | { status: "replay" }
  | { status: "expired" };

interface DescribeResult {
  email: string | null;
  rotatedAt: number | null;
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
  ctx.set<boolean>("revoked", false);
  ctx.set<FamilyState>("family", {
    currentHash: request.hash,
    // Nothing to answer a concurrent-replay with yet — a fresh sign-in has no previous
    // hash for a second caller to present, so this is never read before the first rotation.
    currentToken: "",
    previousHash: null,
    rotatedAt,
    expiresAt: request.expiresAt,
  });
}

async function refresh(ctx: ObjectContext, request: RefreshRequest): Promise<RefreshHandlerResult> {
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
      const [email, sub, provider] = await Promise.all([
        ctx.get<string>("email"),
        ctx.get<string>("sub"),
        ctx.get<string>("provider"),
      ]);
      return { status: "ok", token: f.currentToken, expiresAt: f.expiresAt, email: email ?? "", sub: sub ?? "", provider: provider ?? "" };
    }
    case "rotate": {
      const f = family as FamilyState;
      const [email, sub, provider] = await Promise.all([
        ctx.get<string>("email"),
        ctx.get<string>("sub"),
        ctx.get<string>("provider"),
      ]);
      const token = `${ctx.rand.uuidv4()}${ctx.rand.uuidv4()}`.replace(/-/g, "");
      const expiresAt = now + REFRESH_TOKEN_TTL_MS;
      ctx.set<FamilyState>("family", {
        currentHash: sha256(token),
        currentToken: token,
        previousHash: f.currentHash,
        rotatedAt: now,
        expiresAt,
      });
      return { status: "ok", token, expiresAt, email: email ?? "", sub: sub ?? "", provider: provider ?? "" };
    }
  }
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

export const operatorObject = restate.object({
  name: "Operator",
  handlers: {
    issue,
    refresh,
    revoke,
    describe: restate.handlers.object.shared(describe),
  },
});

// ---------- RestateRefreshAuthority: the ingress-client seam implementation ----------

export interface RestateRefreshAuthorityOptions {
  /** Defaults to the real ingress (127.0.0.1:8081, AII-627). Overridable for tests. */
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
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

  constructor(options: RestateRefreshAuthorityOptions) {
    this.baseUrl = options.ingressBaseUrl ?? `http://${RESTATE_INGRESS_BIND_ADDRESS}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessTokenTtlMs = options.accessTokenTtlMs;
  }

  private async invoke<T>(clientId: string, handler: string, body: unknown): Promise<T | "unavailable"> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/Operator/${encodeURIComponent(clientId)}/${handler}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return "unavailable";
    }
    if (!response.ok) {
      return "unavailable";
    }
    try {
      return (await response.json()) as T;
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

  async rotate(input: RefreshInput): Promise<RefreshOutcome> {
    const presentedHash = sha256(input.refreshToken);
    const result = await this.invoke<RefreshHandlerResult>(input.clientId, "refresh", { presentedHash });
    if (result === "unavailable") {
      return { status: "unavailable" };
    }
    if (result.status === "replay") {
      return { status: "replay" };
    }
    if (result.status === "expired") {
      return { status: "expired" };
    }

    const now = Date.now();
    const accessToken = crypto.randomBytes(32).toString("hex");
    getDb()
      .prepare(
        "INSERT INTO mcp_tokens (token, email, sub, provider, created_at, expires_at, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(accessToken, result.email, result.sub, result.provider, now, now + this.accessTokenTtlMs, input.clientId);

    return {
      status: "ok",
      accessToken,
      refreshToken: result.token,
      expiresInSeconds: Math.floor(this.accessTokenTtlMs / 1000),
    };
  }

  async revokeFamily(clientId: string): Promise<void> {
    // One object per client id (AII-709) — the "family" this seam names is the whole
    // client's refresh state, so revoking it is the object's own `revoke` handler.
    await this.invoke(clientId, "revoke", {});
  }
}
