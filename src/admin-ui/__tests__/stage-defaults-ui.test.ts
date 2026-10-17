// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { modelsAndProvidersHtml, modelsAndProvidersScript } from "../pages/models-and-providers.js";
import { settingsHtml, settingsScript } from "../pages/settings.js";

type W = Window & Record<string, any>;
const w = window as unknown as W;
const SENT = '<img src=x onerror="window.__pwn=1">';

const ACCOUNTS = [
  { profileId: "p-claude", identity: SENT, agent: "claude", provider: "anthropic", authMode: "claude-subscription", allowedProjectKeys: [SENT], profileStatus: "active", credentialRef: "SECRET-REF", token: "SECRET-TOKEN", sessionState: "SECRET-STATE", account: { readiness: "unknown", failureCode: null, sessionRecovery: { state: "recovery_required", recoveryRequired: true } } },
  { profileId: "p-gpt", identity: "gpt", agent: "codex", provider: "openai", authMode: "codex-subscription", allowedProjectKeys: ["AII"], profileStatus: "active", account: { readiness: "refresh failed (transient)", failureCode: "x", sessionRecovery: { state: "busy", recoveryRequired: true } } },
  { profileId: "p-gpt2", identity: "gpt2", agent: "codex", provider: "openai", authMode: "codex-subscription", allowedProjectKeys: [], profileStatus: "active", account: { readiness: "sign-in required", failureCode: null } },
  { profileId: "p-gpt3", identity: "gpt3", agent: "codex", provider: "openai", authMode: "codex-subscription", allowedProjectKeys: ["AII"], profileStatus: "active", account: { readiness: "missing", failureCode: null } },
];

interface Stub { calls: { url: string; method: string; body?: any }[]; put?: { status: number; body: any } | "reject" }

function stubFetch(stub: Stub, defaults: any = { configured: false, mode: "legacy", stages: {} }, accounts: any[] = ACCOUNTS) {
  vi.stubGlobal("fetch", vi.fn());
  w.api = async (url: string, opts: any = {}) => {
    const method = opts.method ?? "GET";
    stub.calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const res = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body });
    if (method === "PUT") {
      if (stub.put === "reject") throw new Error("network down");
      return stub.put ? res(stub.put.status, stub.put.body) : res(200, { configured: true, mode: "legacy", ...JSON.parse(opts.body) });
    }
    if (url === "/api/agent-defaults") return res(200, defaults);
    if (url === "/api/model-accounts") return res(200, { accounts });
    return res(200, {});
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootModels(admin = true, defaults?: any, accounts?: any[], stub: Stub = { calls: [] }) {
  document.body.innerHTML = modelsAndProvidersHtml;
  stubFetch(stub, defaults, accounts);
  w.esc = (s: string) => { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; };
  w.escAttr = (s: string) => w.esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  w.isAdmin = () => admin;
  let init: () => void = () => {};
  w.registerPage = (_: string, fn: () => void) => { init = fn; };
  vi.spyOn(window, "setInterval").mockReturnValue(0 as any);
  new Function(modelsAndProvidersScript)();
  init();
  await tick(); await tick(); await tick();
  return stub;
}

const field = (stage: string, f: string) => document.querySelector(`#mp-stage-rows [data-stage="${stage}"][data-field="${f}"]`) as HTMLInputElement;

describe("models page stage defaults", () => {
  beforeEach(() => { w.__pwn = undefined; });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("renders sentinels as text and never shows credential fields", async () => {
    await bootModels();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain(SENT);
    for (const secret of ["SECRET-REF", "SECRET-TOKEN", "SECRET-STATE"]) expect(document.body.innerHTML).not.toContain(secret);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("labels ChatGPT plan and statuses, with recovery only for Claude subscription", async () => {
    await bootModels();
    const rows = Array.from(document.querySelectorAll("#mp-account-rows tr"));
    const gpt = rows[1].textContent!;
    expect(gpt).toContain("ChatGPT plan");
    expect(gpt).toContain("refresh failed");
    expect(gpt).not.toContain("transient");
    expect(gpt).not.toContain("codex-subscription");
    expect(gpt).not.toContain("recovery");
    expect(gpt).not.toContain("busy");
    expect(rows[0].textContent).toContain("recovery_required");
    expect(rows[2].textContent).toContain("node dist/chatgpt-plan-login.js login");
    expect(rows[2].textContent).toContain("chatgpt-import");
    expect(rows[3].textContent).toContain("chatgpt-import");
    expect(document.getElementById("mp-stage-card")!.textContent).not.toContain("codex-subscription");
  });

  it("uses a time-limit label and no turns wording in the stage table", async () => {
    await bootModels(true, { configured: true, mode: "configured", stages: { review: { agent: "codex", provider: "openai" } } });
    const head = document.querySelector("#mp-stage-card thead")!.textContent!;
    expect(head).toContain("Elapsed time limit");
    expect(document.getElementById("mp-stage-rows")!.textContent!.toLowerCase()).not.toContain("turns");
  });

  it("filters profiles by agent/provider and explains an empty list", async () => {
    await bootModels(true, { configured: true, mode: "configured", stages: { review: { agent: "codex", provider: "openai" }, planning: { agent: "claude", provider: "bedrock" } } });
    const opts = Array.from((field("review", "accountProfileId") as unknown as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).toEqual(["", "p-gpt", "p-gpt2", "p-gpt3"]);
    expect(document.getElementById("mp-stage-hints")!.textContent).toContain("planning: no compatible active account profile");
  });

  it("shows guidance when there are no accounts", async () => {
    await bootModels(true, undefined, []);
    expect(document.getElementById("mp-account-empty")!.classList.contains("hidden")).toBe(false);
  });

  it("saves the full stages object with null for cleared fields", async () => {
    const stub = await bootModels(true, { configured: true, mode: "configured", stages: { planning: { agent: "claude" } } });
    field("review", "agent").value = "codex";
    field("review", "agent").dispatchEvent(new Event("change", { bubbles: true }));
    field("review", "model").value = "m1";
    field("review", "invocationTimeoutMs").value = "60000";
    w.saveStageDefaults();
    await tick(); await tick();
    const put = stub.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/agent-defaults");
    expect(put.body.mode).toBe("configured");
    expect(put.body.stages.planning).toEqual({ agent: "claude", provider: null, model: null, accountProfileId: null, invocationTimeoutMs: null });
    expect(put.body.stages.review).toMatchObject({ agent: "codex", model: "m1", invocationTimeoutMs: 60000, provider: null });
    expect(put.body.stages.implementation.agent).toBeNull();
  });

  for (const [name, put] of [["400", { status: 400, body: { error: "bad " + SENT } }], ["409", { status: 409, body: { error: "stale_inputs" } }], ["422", { status: 422, body: { error: "nope" } }], ["network", "reject"]] as const) {
    it(`keeps edits and shows the error on ${name}`, async () => {
      await bootModels(true, undefined, undefined, { calls: [], put: put as any });
      field("review", "model").value = "typed-model";
      field("review", "model").dispatchEvent(new Event("input", { bubbles: true }));
      w.saveStageDefaults();
      await tick(); await tick();
      const err = document.getElementById("mp-stage-error")!;
      expect(err.classList.contains("hidden")).toBe(false);
      expect(err.textContent!.length).toBeGreaterThan(5);
      expect(document.querySelector("img")).toBeNull();
      expect(field("review", "model").value).toBe("typed-model");
      // a poll must not clobber a dirty form
      await w.loadModelsAndProviders();
      await tick(); await tick();
      expect(field("review", "model").value).toBe("typed-model");
    });
  }

  it("rejects a non-positive limit client-side", async () => {
    const stub = await bootModels();
    field("review", "invocationTimeoutMs").value = "-5";
    w.saveStageDefaults();
    await tick();
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(document.getElementById("mp-stage-error")!.textContent).toContain("positive");
  });

  it("withholds mutation from non-admins and sends no write", async () => {
    const stub = await bootModels(false);
    expect(document.getElementById("mp-stage-actions")!.classList.contains("hidden")).toBe(true);
    expect(field("review", "model").disabled).toBe(true);
    w.saveStageDefaults();
    await tick();
    expect(stub.calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("settings agent defaults card", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function bootSettings(admin: boolean, put?: Stub["put"]) {
    document.body.innerHTML = settingsHtml;
    const stub: Stub = { calls: [], put };
    stubFetch(stub, { configured: true, mode: "configured", stages: { review: { agent: "codex" } } });
    const base = w.api;
    w.api = async (url: string, opts?: any) => (url === "/api/settings" || url === "/api/global-secrets" ? { ok: true, status: 200, json: async () => (url === "/api/settings" ? { flySessionsApp: {}, flySessionsRegion: {}, linearPickupLabel: { value: null, effective: "x" } } : []) } : base(url, opts));
    w.esc = (s: string) => s;
    w.isAdmin = () => admin;
    let init: () => void = () => {};
    w.registerPage = (_: string, fn: () => void) => { init = fn; };
    new Function(settingsScript)();
    init();
    await tick(); await tick(); await tick();
    return stub;
  }

  it("saves mode with the current stages, for admins", async () => {
    const stub = await bootSettings(true);
    const mode = document.getElementById("settings-agent-defaults-mode") as HTMLSelectElement;
    expect(mode.value).toBe("configured");
    mode.value = "legacy";
    w.saveAgentDefaultsMode();
    await tick(); await tick();
    const put = stub.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ mode: "legacy", stages: { review: { agent: "codex" } } });
  });

  it("shows a server error and keeps the selection", async () => {
    await bootSettings(true, { status: 409, body: { error: "stale " + SENT } });
    const mode = document.getElementById("settings-agent-defaults-mode") as HTMLSelectElement;
    mode.value = "legacy";
    mode.dispatchEvent(new Event("change"));
    w.saveAgentDefaultsMode();
    await tick(); await tick();
    const err = document.getElementById("settings-agent-defaults-error")!;
    expect(err.classList.contains("hidden")).toBe(false);
    expect(err.textContent).toContain("stale");
    expect(document.querySelector("img")).toBeNull();
    expect(mode.value).toBe("legacy");
  });

  it("is read-only for non-admins", async () => {
    const stub = await bootSettings(false);
    expect((document.getElementById("settings-agent-defaults-mode") as HTMLSelectElement).disabled).toBe(true);
    w.saveAgentDefaultsMode();
    await tick();
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
