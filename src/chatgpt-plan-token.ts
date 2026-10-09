/**
 * ChatGPT plan credential record and the OpenAI refresh call.
 * One module for both refreshers so the record format, expiry rule, and error classes cannot drift.
 * Uses only `node:` modules and the global fetch. No token value ever reaches a reason, result, or thrown error.
 */

export const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";

const ISSUER = "https://auth.openai.com";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const REFRESH_TIMEOUT_MS = 10_000;

export interface ChatGptPlanRecordV1 {
  version: 1;
  email: string;
  issuer: "https://auth.openai.com";
  subject: string;
  clientId: string;
  extAgentHostId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  scopes: string[];
  accessTokenExpiresAt: number;
  earliestRefreshAt: number | null;
  savedAt: number;
}

export type ParseResult = { ok: true; value: ChatGptPlanRecordV1 } | { ok: false; reason: string };

const STRING_FIELDS = ["email", "subject", "clientId", "extAgentHostId", "idToken", "accessToken", "refreshToken"] as const;

/** Validates untrusted JSON into a record. `reason` names a field, never a value. */
export function parseChatGptPlanRecord(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "record must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, reason: "version must be 1" };
  if (r.issuer !== ISSUER) return { ok: false, reason: "issuer is not the expected issuer" };
  if (r.tokenType !== "Bearer") return { ok: false, reason: "tokenType must be Bearer" };
  for (const field of STRING_FIELDS) {
    const v = r[field];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, reason: `${field} must be a non-empty string` };
    }
  }
  if (r.clientId === "dynamic_agent_client") {
    return { ok: false, reason: "clientId must be an issued client_id" };
  }
  if (!Array.isArray(r.scopes) || !r.scopes.every((s) => typeof s === "string" && s.length > 0)) {
    return { ok: false, reason: "scopes must be an array of strings" };
  }
  if (!r.scopes.includes(REQUIRED_SCOPE)) {
    return { ok: false, reason: `scopes must include ${REQUIRED_SCOPE}` };
  }
  if (typeof r.accessTokenExpiresAt !== "number" || !Number.isFinite(r.accessTokenExpiresAt)) {
    return { ok: false, reason: "accessTokenExpiresAt must be a finite number" };
  }
  if (r.earliestRefreshAt !== null && (typeof r.earliestRefreshAt !== "number" || !Number.isFinite(r.earliestRefreshAt))) {
    return { ok: false, reason: "earliestRefreshAt must be null or a finite number" };
  }
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt)) {
    return { ok: false, reason: "savedAt must be a finite number" };
  }
  return {
    ok: true,
    value: {
      version: 1,
      email: r.email as string,
      issuer: ISSUER,
      subject: r.subject as string,
      clientId: r.clientId as string,
      extAgentHostId: r.extAgentHostId as string,
      idToken: r.idToken as string,
      accessToken: r.accessToken as string,
      refreshToken: r.refreshToken as string,
      tokenType: "Bearer",
      scopes: [...(r.scopes as string[])].sort(),
      accessTokenExpiresAt: r.accessTokenExpiresAt,
      earliestRefreshAt: r.earliestRefreshAt as number | null,
      savedAt: r.savedAt,
    },
  };
}

export function serializeChatGptPlanRecord(record: ChatGptPlanRecordV1): string {
  return JSON.stringify(record);
}

/** True when the access token still has at least `requiredMs` of life left. */
export function accessTokenUsableFor(record: ChatGptPlanRecordV1, now: number, requiredMs: number): boolean {
  return record.accessTokenExpiresAt - now >= requiredMs;
}

/** True when the token lacks `requiredMs` of life or `earliestRefreshAt` has passed. */
export function shouldRefresh(record: ChatGptPlanRecordV1, now: number, requiredMs: number): boolean {
  if (!accessTokenUsableFor(record, now, requiredMs)) return true;
  return record.earliestRefreshAt !== null && now >= record.earliestRefreshAt;
}

export type RefreshFailure = "reauth_required" | "invalid_client" | "transient";

export type RefreshResult =
  | { ok: true; record: ChatGptPlanRecordV1 }
  | { ok: false; failure: RefreshFailure; status: number | null; code: string | null };

const REAUTH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

function fail(failure: RefreshFailure, status: number | null, code: string | null = null): RefreshResult {
  return { ok: false, failure, status, code };
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
}

function classifyError(status: number, code: string | null): RefreshFailure {
  if (code === "invalid_client") return "invalid_client";
  if (status >= 500 || status === 429) return "transient";
  if ((status === 400 || status === 401) && code !== null && REAUTH_CODES.has(code)) return "reauth_required";
  if (status >= 400 && status < 500) return "reauth_required";
  return "transient";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Exchanges the record's refresh token. On success every rotated field is replaced together. */
export async function refreshChatGptPlanRecord(
  record: ChatGptPlanRecordV1,
  deps: { fetch: typeof fetch; now: () => number },
): Promise<RefreshResult> {
  let status: number | null = null;
  let body: Record<string, unknown> | null;
  try {
    const res = await deps.fetch(CHATGPT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: record.clientId,
        refresh_token: record.refreshToken,
        resource: CHATGPT_RESOURCE,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    status = res.status;
    try {
      body = asObject(await res.json());
    } catch {
      body = null;
    }
  } catch {
    // Network error or abort: the original message may embed request text, so drop it.
    return fail("transient", status);
  }

  if (body === null) return fail("transient", status);

  if (status !== 200) {
    const code = safeCode(body.error);
    return fail(classifyError(status, code), status, code);
  }

  const { access_token, refresh_token, id_token, expires_in, scope, earliest_refresh_at } = body;
  if (typeof access_token !== "string" || !access_token || typeof refresh_token !== "string" || !refresh_token) {
    return fail("transient", status);
  }
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in)) return fail("transient", status);

  const now = deps.now();
  const scopes =
    typeof scope === "string"
      ? [...new Set(scope.split(/\s+/).filter(Boolean))].sort()
      : record.scopes;
  const candidate: ChatGptPlanRecordV1 = {
    ...record,
    accessToken: access_token,
    refreshToken: refresh_token,
    idToken: typeof id_token === "string" && id_token ? id_token : record.idToken,
    accessTokenExpiresAt: now + expires_in * 1000,
    scopes,
    earliestRefreshAt:
      typeof earliest_refresh_at === "number" && Number.isFinite(earliest_refresh_at) ? earliest_refresh_at * 1000 : null,
    savedAt: now,
  };
  // A malformed 200 must not erase a good session, so it is transient rather than reauth.
  const checked = parseChatGptPlanRecord(candidate);
  if (!checked.ok) return fail("transient", status);
  return { ok: true, record: checked.value };
}
