import { describe, expect, it, vi } from "vitest";
import { checkModelAccountKey, type ModelAccountKeyCheckDeps } from "../model-account-key-check.js";
import type { CredentialFailureCode } from "../model-credentials.js";
import { makeStageAgentProfile } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout, type Reply } from "./helpers/fake-fetch.js";

const key = "SENTINEL-PRIVATE-OPENROUTER-KEY";
const profileId = "health-test";
function fixture(reply: Reply = { status: 200 }) {
  const fake = fakeFetch({ "GET /api/v1/key": reply });
  const deps: ModelAccountKeyCheckDeps = {
    readProfile: vi.fn<ModelAccountKeyCheckDeps["readProfile"]>(() => ({ ...makeStageAgentProfile(), status: "active", provider: "openrouter", authMode: "openrouter-api-key" })),
    readBinding: vi.fn(() => ({ destination: "openrouter/openrouter-api-key" })),
    resolveCredential: vi.fn<ModelAccountKeyCheckDeps["resolveCredential"]>(() => ({ ok: true, profileId, revision: 1, authMode: "openrouter-api-key", secret: { kind: "api-key", apiKey: key } })),
    fetch: fake.fetch,
  };
  return { deps, fake, check: () => checkModelAccountKey(profileId, deps) };
}
const unchecked = { credential: "not-checked", binding: "not-checked", provider: "not-checked" };

describe("checkModelAccountKey", () => {
  it("returns not-found without later reads", async () => {
    const f = fixture(); vi.mocked(f.deps.readProfile).mockReturnValue(null);
    expect(await f.check()).toEqual({ profileId, profile: "not-found", ...unchecked });
    expect(f.deps.readBinding).not.toHaveBeenCalled(); expect(f.deps.resolveCredential).not.toHaveBeenCalled(); expect(f.fake.calls).toHaveLength(0);
  });
  it.each(["disabled", "archived"] as const)("stops for %s profiles", async status => {
    const f = fixture(); const profile = f.deps.readProfile(profileId)!;
    vi.mocked(f.deps.readProfile).mockReturnValue({ ...profile, status });
    expect(await f.check()).toEqual({ profileId, profile: "disabled", ...unchecked });
    expect(f.deps.readBinding).not.toHaveBeenCalled(); expect(f.deps.resolveCredential).not.toHaveBeenCalled(); expect(f.fake.calls).toHaveLength(0);
  });
  it("stops for unsupported auth mode", async () => {
    const f = fixture(); vi.mocked(f.deps.readProfile).mockReturnValue({ ...makeStageAgentProfile(), status: "active" });
    expect(await f.check()).toEqual({ profileId, profile: "unsupported-auth-mode", ...unchecked });
    expect(f.deps.readBinding).not.toHaveBeenCalled(); expect(f.deps.resolveCredential).not.toHaveBeenCalled(); expect(f.fake.calls).toHaveLength(0);
  });
  it.each([true, false])("continues with binding present=%s and resolves the selected revision", async present => {
    const f = fixture(); if (!present) vi.mocked(f.deps.readBinding).mockReturnValue(undefined);
    expect(await f.check()).toEqual({ profileId, profile: "ok", binding: present ? "ok" : "missing", credential: "set", provider: "pass" });
    expect(f.deps.readBinding).toHaveBeenCalledWith(profileId, 1);
    expect(f.deps.resolveCredential).toHaveBeenCalledWith({ profileId, revision: 1, provider: "openrouter", authMode: "openrouter-api-key" });
    expect(f.fake.calls[0]!.url.href).toBe("https://openrouter.ai/api/v1/key");
    expect(f.fake.calls[0]!.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(f.fake.calls[0]!.method).toBe("GET"); expect(f.fake.calls[0]!.body).toBe("");
  });
  it("refuses a mismatched binding before reading the key", async () => {
    const f = fixture(); vi.mocked(f.deps.readBinding).mockReturnValue({ destination: "anthropic/anthropic-api-key" });
    expect(await f.check()).toEqual({ profileId, profile: "ok", binding: "mismatch", credential: "not-checked", provider: "not-checked" });
    expect(f.deps.resolveCredential).not.toHaveBeenCalled(); expect(f.fake.calls).toHaveLength(0);
  });
  const codes: CredentialFailureCode[] = ["invalid_request", "profile_not_found", "profile_disabled", "account_mismatch", "reference_missing", "reference_rejected", "secret_unavailable", "secret_invalid", "session_unavailable"];
  it.each(codes)("returns credential failure %s without a request", async code => {
    const f = fixture(); vi.mocked(f.deps.resolveCredential).mockReturnValue({ ok: false, category: "authentication_required", code });
    expect(await f.check()).toEqual({ profileId, profile: "ok", binding: "ok", credential: code, provider: "not-checked" });
    expect(f.fake.calls).toHaveLength(0);
  });
  it.each([200, 204, 299, 401, 403, 302, 429, 500])("maps HTTP %s and disables redirects", async status => {
    const f = fixture({ status });
    const spy = vi.fn(f.deps.fetch); f.deps.fetch = spy;
    expect((await f.check()).provider).toBe(status < 300 ? "pass" : status === 401 || status === 403 ? `fail (key refused, status ${status})` : `fail (status ${status})`);
    expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });
  it("aborts at 20 seconds", async () => {
    const timeout = stubAbortTimeout(20_000);
    const f = fixture(hangUntilAborted);
    expect((await f.check()).provider).toBe("fail (no answer)");
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
  it.each([false, true])("never returns or logs the key, including in a fetch exception (%s)", async throws => {
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map(name => vi.spyOn(console, name).mockImplementation(() => {}));
    try {
      const f = fixture(throws ? () => { throw new Error(`request failed: ${key}`); } : { text: key });
      const result = await f.check();
      expect(result.provider).toBe(throws ? "fail (no answer)" : "pass");
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toContain(key);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  it.each(["readProfile", "readBinding", "resolveCredential"] as const)("sanitizes unexpected %s exceptions", async name => {
    const f = fixture(); vi.mocked(f.deps[name]).mockImplementation(() => { throw new Error(key); });
    await expect(f.check()).rejects.toThrow(/^could not check the model account key$/);
    expect(f.fake.calls).toHaveLength(0);
  });
});
