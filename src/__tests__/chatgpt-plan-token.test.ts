import { describe, it, expect, vi } from "vitest";
import {
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_ENDPOINT,
  accessTokenUsableFor,
  parseChatGptPlanRecord,
  refreshChatGptPlanRecord,
  serializeChatGptPlanRecord,
  shouldRefresh,
  type ChatGptPlanRecordV1,
} from "../chatgpt-plan-token.js";

const SENTINEL = "SENTINEL-secret-token-value";
const NOW = 1_800_000_000_000;

function record(over: Partial<ChatGptPlanRecordV1> = {}): ChatGptPlanRecordV1 {
  return {
    version: 1,
    email: "a@example.com",
    issuer: "https://auth.openai.com",
    subject: "sub-1",
    clientId: "client-1",
    extAgentHostId: "urn:uuid:1234",
    idToken: "old-id",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "Bearer",
    scopes: ["chatgpt.tokens.use.direct", "openid"],
    accessTokenExpiresAt: NOW + 3_600_000,
    earliestRefreshAt: null,
    savedAt: NOW - 1000,
    ...over,
  };
}

function resp(status: number, body: unknown, jsonThrows = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (jsonThrows) throw new SyntaxError(`Unexpected token ${SENTINEL}`);
      return body;
    },
    text: async () => JSON.stringify(body),
  };
}

function run(r: ChatGptPlanRecordV1, f: ReturnType<typeof vi.fn>) {
  return refreshChatGptPlanRecord(r, { fetch: f as unknown as typeof fetch, now: () => NOW });
}

describe("parseChatGptPlanRecord", () => {
  it("accepts a valid record and round-trips", () => {
    const rec = record();
    const out = parseChatGptPlanRecord(JSON.parse(serializeChatGptPlanRecord(rec)));
    expect(out).toEqual({ ok: true, value: rec });
  });

  it.each(["email", "subject", "clientId", "extAgentHostId", "idToken", "accessToken", "refreshToken"])(
    "rejects missing %s",
    (field) => {
      const raw: Record<string, unknown> = { ...record() };
      delete raw[field];
      const out = parseChatGptPlanRecord(raw);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(field);
    },
  );

  it.each(["accessTokenExpiresAt", "savedAt", "earliestRefreshAt"])("rejects non-finite %s", (field) => {
    for (const bad of [NaN, Infinity, "123"]) {
      const out = parseChatGptPlanRecord({ ...record(), [field]: bad });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(field);
    }
  });

  it("rejects dynamic_agent_client", () => {
    const out = parseChatGptPlanRecord(record({ clientId: "dynamic_agent_client" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("clientId");
  });

  it("rejects scopes lacking the direct scope", () => {
    const out = parseChatGptPlanRecord(record({ scopes: ["openid"] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("scopes");
  });

  it("rejects non-object, wrong version, issuer, tokenType", () => {
    expect(parseChatGptPlanRecord(null).ok).toBe(false);
    expect(parseChatGptPlanRecord([]).ok).toBe(false);
    expect(parseChatGptPlanRecord({ ...record(), version: 2 }).ok).toBe(false);
    expect(parseChatGptPlanRecord({ ...record(), issuer: "https://evil.example" }).ok).toBe(false);
    expect(parseChatGptPlanRecord({ ...record(), tokenType: "mac" }).ok).toBe(false);
  });

  it("never puts token values in the reason", () => {
    const out = parseChatGptPlanRecord(
      record({ idToken: SENTINEL, accessToken: SENTINEL, refreshToken: SENTINEL, clientId: "dynamic_agent_client" }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).not.toContain(SENTINEL);
  });
});

describe("expiry rule", () => {
  it("accessTokenUsableFor is inclusive at the boundary", () => {
    const r = record({ accessTokenExpiresAt: NOW + 1000 });
    expect(accessTokenUsableFor(r, NOW, 1000)).toBe(true);
    expect(accessTokenUsableFor(r, NOW, 1001)).toBe(false);
  });

  it("fresh token does not refresh", () => {
    expect(shouldRefresh(record(), NOW, 60_000)).toBe(false);
  });

  it("token inside requiredMs refreshes", () => {
    expect(shouldRefresh(record({ accessTokenExpiresAt: NOW + 30_000 }), NOW, 60_000)).toBe(true);
  });

  it("past earliestRefreshAt refreshes even if fresh; before it does not", () => {
    expect(shouldRefresh(record({ earliestRefreshAt: NOW }), NOW, 60_000)).toBe(true);
    expect(shouldRefresh(record({ earliestRefreshAt: NOW + 1 }), NOW, 60_000)).toBe(false);
  });

  it("null earliestRefreshAt falls back to expiry", () => {
    expect(shouldRefresh(record({ earliestRefreshAt: null }), NOW, 60_000)).toBe(false);
  });
});

describe("refreshChatGptPlanRecord", () => {
  it("sends a form POST without scope and with an abort signal", async () => {
    const f = vi.fn().mockResolvedValue(resp(200, { access_token: "a", refresh_token: "r", expires_in: 10 }));
    await run(record(), f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(CHATGPT_TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body.toString());
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: "client-1",
      refresh_token: "old-refresh",
      resource: CHATGPT_RESOURCE,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rotates every field together on 200", async () => {
    const f = vi.fn().mockResolvedValue(
      resp(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: "new-id",
        expires_in: 3600,
        scope: "openid chatgpt.tokens.use.direct openid",
        earliest_refresh_at: 1_800_000_500,
      }),
    );
    const out = await run(record(), f);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id",
      accessTokenExpiresAt: NOW + 3_600_000,
      scopes: ["chatgpt.tokens.use.direct", "openid"],
      earliestRefreshAt: 1_800_000_500_000,
      savedAt: NOW,
    });
    expect(JSON.stringify(out)).not.toContain("old-refresh");
    expect(JSON.stringify(out)).not.toContain("old-access");
  });

  it("keeps idToken when absent and nulls a missing earliest_refresh_at", async () => {
    const f = vi.fn().mockResolvedValue(resp(200, { access_token: "a", refresh_token: "r", expires_in: 10 }));
    const out = await run(record({ earliestRefreshAt: 5 }), f);
    expect(out.ok && out.record.idToken).toBe("old-id");
    expect(out.ok && out.record.earliestRefreshAt).toBeNull();
  });

  it.each([
    [{ refresh_token: "r", expires_in: 10 }],
    [{ access_token: "a", expires_in: 10 }],
    [{ access_token: "a", refresh_token: "r", expires_in: "soon" }],
  ])("incomplete or invalid 200 is transient: %j", async (body) => {
    const input = record();
    const before = JSON.stringify(input);
    const out = await run(input, vi.fn().mockResolvedValue(resp(200, body)));
    expect(out).toEqual({ ok: false, failure: "transient", status: 200, code: null });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("a 200 whose scope drops the direct scope is reauth_required and leaves the record unchanged", async () => {
    const input = record();
    const before = JSON.stringify(input);
    const body = { access_token: "a", refresh_token: "r", expires_in: 10, scope: "openid" };
    const out = await run(input, vi.fn().mockResolvedValue(resp(200, body)));
    expect(out).toEqual({ ok: false, failure: "reauth_required", status: 200, code: null });
    expect(JSON.stringify(input)).toBe(before);
  });

  const reauthCodes = [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ];
  it.each(reauthCodes.flatMap((c) => [400, 401].map((s) => [s, c] as const)))(
    "%i %s is reauth_required",
    async (status, code) => {
      const out = await run(record(), vi.fn().mockResolvedValue(resp(status, { error: code })));
      expect(out).toEqual({ ok: false, failure: "reauth_required", status, code });
    },
  );

  it.each([400, 401, 500])("invalid_client at %i", async (status) => {
    const out = await run(record(), vi.fn().mockResolvedValue(resp(status, { error: "invalid_client" })));
    expect(out).toEqual({ ok: false, failure: "invalid_client", status, code: "invalid_client" });
  });

  it.each([500, 503, 429])("%i is transient even with a reauth code", async (status) => {
    const out = await run(record(), vi.fn().mockResolvedValue(resp(status, { error: "invalid_grant" })));
    expect(out).toMatchObject({ ok: false, failure: "transient", status });
  });

  it("network error and abort are transient with null status", async () => {
    const net = await run(record(), vi.fn().mockRejectedValue(new Error(`boom ${SENTINEL}`)));
    expect(net).toEqual({ ok: false, failure: "transient", status: null, code: null });
    const abort = await run(record(), vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    expect(abort).toEqual({ ok: false, failure: "transient", status: null, code: null });
  });

  it("non-JSON body is transient and leaks nothing", async () => {
    const out = await run(record(), vi.fn().mockResolvedValue(resp(400, null, true)));
    expect(out).toEqual({ ok: false, failure: "transient", status: 400, code: null });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it.each([403, 404])("other 4xx (%i) is reauth_required", async (status) => {
    expect(await run(record(), vi.fn().mockResolvedValue(resp(status, {})))).toEqual({
      ok: false,
      failure: "reauth_required",
      status,
      code: null,
    });
    expect(await run(record(), vi.fn().mockResolvedValue(resp(status, { error: "weird" })))).toMatchObject({
      failure: "reauth_required",
      code: "weird",
    });
  });

  it.each([["Invalid_Grant"], ["x".repeat(65)], [42], ["has space"]])("code filter nulls %j", async (error) => {
    const out = await run(record(), vi.fn().mockResolvedValue(resp(400, { error })));
    expect(out).toMatchObject({ ok: false, failure: "reauth_required", code: null });
  });

  it("never echoes tokens from the request or response", async () => {
    const out = await run(
      record({ refreshToken: SENTINEL }),
      vi.fn().mockResolvedValue(resp(400, { error: "invalid_grant", error_description: SENTINEL, refresh_token: SENTINEL })),
    );
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });
});
