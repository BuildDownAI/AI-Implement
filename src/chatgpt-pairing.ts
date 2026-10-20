/**
 * ChatGPT plan pairing (AII-1501): a single-use code lets the laptop helper upload its sign-in record to the
 * orchestrator without an admin credential or shell access. Also home of the import shared with the
 * `chatgpt-import` CLI command, so both paths validate, scope-check, re-host and store a record identically.
 *
 * Trust boundary: the pairing code (256 bits, shown once) to the protected session store. Only the code's SHA-256
 * hash is stored. No code or token reaches a log, an error, or a response; failures carry fixed codes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountProfileProjection } from "./agent-config-store.js";
import { parseChatGptPlanRecord, serializeChatGptPlanRecord } from "./chatgpt-plan-token.js";
import { getDb } from "./dedup.js";
import { PLAN_RECORD_OWNER_GENERATION } from "./model-session-store.js";
import type { ModelSessionStore } from "./model-session-store.js";

export const HOST_ID_KEY = "chatgpt_plan_host_id";
export const PAIRING_TTL_MS = 15 * 60 * 1000;
/** A plan record is a few KB; this is the ceiling on the upload body. */
export const PAIRING_UPLOAD_MAX_BYTES = 64 * 1024;
export const PAIRING_OPERATOR = "chatgpt-pairing";

/** An error whose message is safe to print: fixed text only. */
export class SafeError extends Error {}

type Db = () => ReturnType<typeof getDb>;

/** `INSERT OR IGNORE` then read back, so concurrent first uses agree on one id. */
export function orchestratorHostId(db: Db = getDb): string {
  const conn = db();
  conn.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  conn.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(HOST_ID_KEY, `urn:uuid:${randomUUID()}`);
  const row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(HOST_ID_KEY) as { value: string } | undefined;
  if (!row) throw new SafeError("could not read the orchestrator host id");
  return row.value;
}

export function latestPlanSequence(profileId: string, db: Db = getDb): number | null {
  const row = db()
    .prepare("SELECT MAX(checkpoint_sequence) AS seq FROM model_session_generations WHERE profile_id = ? AND owner_generation = ?")
    .get(profileId, PLAN_RECORD_OWNER_GENERATION) as { seq: number | null } | undefined;
  return row?.seq ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------------------------------

const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

/** Mints a code for a profile and invalidates that profile's unused codes. The plaintext is returned once and never stored. */
export function mintPairingCode(profileId: string, now: number, db: Db = getDb): { code: string; expiresAt: number } {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  const conn = db();
  conn.transaction(() => {
    conn.prepare("UPDATE chatgpt_pairing_codes SET used_at = ? WHERE profile_id = ? AND used_at IS NULL").run(now, profileId);
    conn
      .prepare("INSERT INTO chatgpt_pairing_codes (code_hash, profile_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)")
      .run(hashCode(code), profileId, expiresAt, now);
    // Expired and used rows carry no value past a day.
    conn.prepare("DELETE FROM chatgpt_pairing_codes WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);
  })();
  return { code, expiresAt };
}

/**
 * Looks the code up and marks it used in one statement, so two concurrent uploads cannot both win. Returns the
 * profile id, or null for an unknown, expired or used code.
 */
export function consumePairingCode(code: string, now: number, db: Db = getDb): string | null {
  const row = db()
    .prepare("UPDATE chatgpt_pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING profile_id")
    .get(now, hashCode(code), now) as { profile_id: string } | undefined;
  return row?.profile_id ?? null;
}

/** The bearer value of an Authorization header, or null when absent or not `Bearer <token>`. */
export function bearerCode(header: string | undefined): string | null {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared import
// ---------------------------------------------------------------------------------------------------------------------

export interface ImportDeps {
  store: () => ModelSessionStore;
  hostId: () => string;
  planSequence: (profileId: string) => number | null;
  getProfile: (profileId: string) => AccountProfileProjection | null;
  requestRefresh: (profileId: string) => Promise<void>;
  /** Latest refresh outcome for the status fields; best-effort. */
  readState?: (profileId: string) => Promise<{ lastOutcome: string } | null>;
  now: () => number;
  operator: string;
}

export type ImportFailureCode =
  | "unknown_profile"
  | "wrong_type"
  | "inactive"
  | "not_object"
  | "invalid_record"
  | "stale_sequence"
  | "write_failed";

export type ImportResult =
  | { ok: false; code: ImportFailureCode; reason?: string }
  | {
      ok: true;
      hostId: string;
      refreshRequested: boolean;
      /** The `chatgpt-status` fields. */
      status: { email: string; secondsLeft: number; lastRefresh: string };
    };

/**
 * Validates a record, checks the `chatgpt.tokens.use.direct` scope (inside the parser), replaces the host id with the
 * orchestrator's, stores it encrypted and requests one refresh. Nothing is written for an unusable profile or record.
 */
export async function importChatGptRecord(profileId: string, raw: Record<string, unknown> | null, deps: ImportDeps): Promise<ImportResult> {
  const profile = deps.getProfile(profileId);
  if (!profile) return { ok: false, code: "unknown_profile" };
  if (profile.authMode !== "codex-subscription") return { ok: false, code: "wrong_type" };
  if (profile.status !== "active") return { ok: false, code: "inactive" };
  if (!raw) return { ok: false, code: "not_object" };
  const parsed = parseChatGptPlanRecord(raw);
  if (!parsed.ok) return { ok: false, code: "invalid_record", reason: parsed.reason };
  const record = { ...parsed.value, extAgentHostId: deps.hostId() };
  // The old row may be unreadable (rotated secret, corruption); import is the recovery path, so replace it
  // using its sequence without decrypting.
  const written = deps.store().writePlanRecord({
    profileId,
    expectedSequence: deps.planSequence(profileId),
    sessionData: serializeChatGptPlanRecord(record),
    operator: deps.operator,
  });
  if (!written.ok) return { ok: false, code: written.reason === "stale_sequence" ? "stale_sequence" : "write_failed" };
  let refreshRequested = true;
  try {
    await deps.requestRefresh(profileId);
  } catch {
    refreshRequested = false;
  }
  let lastRefresh = "not requested";
  if (refreshRequested) {
    lastRefresh = "unknown";
    try {
      const state = await deps.readState?.(profileId);
      if (state !== undefined) lastRefresh = state ? state.lastOutcome : "never run";
    } catch {
      /* ingress unreachable: leave unknown */
    }
  }
  return {
    ok: true,
    hostId: record.extAgentHostId,
    refreshRequested,
    status: { email: record.email, secondsLeft: Math.floor((record.accessTokenExpiresAt - deps.now()) / 1000), lastRefresh },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Upload route
// ---------------------------------------------------------------------------------------------------------------------

/** The one body every unknown, expired, used or superseded code gets. */
const UNAUTHORIZED_BODY = JSON.stringify({ error: "pairing code is not valid" });

const REFUSALS: Record<ImportFailureCode, { status: number; error: string }> = {
  unknown_profile: { status: 403, error: "the profile cannot take an upload; mint a new code" },
  wrong_type: { status: 403, error: "the profile cannot take an upload; mint a new code" },
  inactive: { status: 403, error: "the profile cannot take an upload; mint a new code" },
  not_object: { status: 400, error: "body must be a JSON object; the code was consumed, mint a new one" },
  invalid_record: { status: 400, error: "record failed validation; the code was consumed, mint a new one" },
  stale_sequence: { status: 409, error: "the record changed during upload; the code was consumed, mint a new one" },
  write_failed: { status: 500, error: "could not write the record; the code was consumed, mint a new one" },
};

function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function readLimited(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => resolve(bytes > maxBytes ? null : Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * `POST /api/chatgpt-pairing/upload`. The bearer code is the only authentication, so this runs outside the admin
 * session gate. The code is consumed before the body is read or the import runs; a refused upload burns it.
 */
export async function handlePairingUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { env: NodeJS.ProcessEnv; now: () => number; import: ImportDeps; db?: Db },
): Promise<void> {
  if (!deps.env.RUNNER_TOKEN_SECRET) {
    reply(res, 503, JSON.stringify({ error: "pairing is not configured on this orchestrator" }));
    return;
  }
  const code = bearerCode(req.headers.authorization);
  const profileId = code ? consumePairingCode(code, deps.now(), deps.db) : null;
  if (!profileId) {
    reply(res, 401, UNAUTHORIZED_BODY);
    return;
  }
  const body = await readLimited(req, PAIRING_UPLOAD_MAX_BYTES);
  if (body === null) {
    console.log(`[chatgpt-pairing] upload refused profile=${profileId} result=too_large`);
    reply(res, 413, JSON.stringify({ error: "record too large; the code was consumed, mint a new one" }));
    return;
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    raw = null;
  }
  let result: ImportResult;
  try {
    result = await importChatGptRecord(profileId, raw, deps.import);
  } catch {
    console.log(`[chatgpt-pairing] upload failed profile=${profileId} result=error`);
    reply(res, 500, JSON.stringify({ error: "could not store the record; the code was consumed, mint a new one" }));
    return;
  }
  if (!result.ok) {
    console.log(`[chatgpt-pairing] upload refused profile=${profileId} result=${result.code}`);
    const refusal = REFUSALS[result.code];
    reply(res, refusal.status, JSON.stringify({ error: refusal.error }));
    return;
  }
  console.log(`[chatgpt-pairing] upload ok profile=${profileId} refresh=${result.refreshRequested ? "requested" : "not_requested"}`);
  reply(res, 200, JSON.stringify(result.status));
}

export interface PairingStatus {
  connected: boolean;
  email: string | null;
  secondsLeft: number | null;
  lastRefresh: string;
}

/** Read-only status for the admin UI: email, seconds left and last refresh outcome. Never returns a token. */
export async function readPairingStatus(
  profileId: string,
  deps: { store: () => Pick<ModelSessionStore, "readPlanRecord">; readState?: ImportDeps["readState"]; now: () => number },
): Promise<PairingStatus> {
  let lastRefresh = "unknown";
  try {
    const state = await deps.readState?.(profileId);
    if (state !== undefined) lastRefresh = state ? state.lastOutcome : "never run";
  } catch {
    /* ingress unreachable: leave unknown */
  }
  const read = deps.store().readPlanRecord(profileId);
  if (!read.ok) return { connected: false, email: null, secondsLeft: null, lastRefresh };
  let data: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(read.sessionData);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) data = v as Record<string, unknown>;
  } catch {
    /* unreadable record: report disconnected */
  }
  const signedIn = typeof data.refreshToken === "string" && data.refreshToken !== "";
  const exp = data.accessTokenExpiresAt;
  return {
    connected: signedIn,
    email: typeof data.email === "string" && data.email ? data.email : null,
    secondsLeft: signedIn && typeof exp === "number" ? Math.floor((exp - deps.now()) / 1000) : null,
    lastRefresh,
  };
}
