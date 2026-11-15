import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { modelsAndProvidersHtml, modelsAndProvidersScript } from "../pages/models-and-providers.js";

describe("models-and-providers page", () => {
  it("declares the expected ids", () => {
    for (const id of ["mp-subtitle", "mp-error", "mp-kpis", "mp-rows", "mp-empty", "kpi-mp-projects", "kpi-mp-anthropic", "kpi-mp-bedrock", "kpi-mp-regions"]) {
      expect(modelsAndProvidersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers the 'models' route and exposes loadModelsAndProviders", () => {
    expect(modelsAndProvidersScript).toContain("window.registerPage('models'");
    expect(modelsAndProvidersScript).toContain("window.loadModelsAndProviders = loadModelsAndProviders");
  });
  it("calls /api/mappings and only the AII-962 stage endpoints", () => {
    expect(modelsAndProvidersScript).toContain("/api/mappings");
    expect(modelsAndProvidersScript).not.toMatch(/\/api\/(models|providers|model-providers)\b/);
    expect(modelsAndProvidersScript).toContain("/api/agent-defaults");
    expect(modelsAndProvidersScript).toContain("/api/model-accounts");
  });
  it("drops the blanket repo-front-matter claim and explains project modes", () => {
    expect(modelsAndProvidersHtml).not.toContain("Edit the model itself in the target repo");
    expect(modelsAndProvidersHtml).not.toContain("not in the orchestrator");
    expect(modelsAndProvidersHtml).toContain("New projects start configured when defaults are on; existing projects keep their mode");
    expect(modelsAndProvidersHtml).toContain("next run");
  });
  it("offers write-only key entry and an add-profile form, without the old read-only subtitle", () => {
    expect(modelsAndProvidersHtml).not.toContain("No credential values are shown or entered here");
    expect(modelsAndProvidersHtml).toContain("Add account profile");
    expect(modelsAndProvidersScript).toContain('type="password"');
    expect(modelsAndProvidersScript).toContain("Set key");
    expect(modelsAndProvidersScript).toContain("Remove key");
    expect(modelsAndProvidersScript).toContain("/credential");
    expect(modelsAndProvidersScript).toContain("input.value = ''");
    expect(modelsAndProvidersScript).not.toMatch(/credentialRef/);
  });
  it("labels each add-form control and keeps its id", () => {
    const labels: Record<string, string> = {
      "mp-new-name": "Name",
      "mp-new-agent": "Agent",
      "mp-new-provider": "Provider",
      "mp-new-authMode": "Authentication",
    };
    for (const [id, text] of Object.entries(labels)) {
      expect(modelsAndProvidersHtml).toContain(`<label for="${id}">${text}</label>`);
      expect(modelsAndProvidersHtml).toContain(`id="${id}"`);
    }
  });
  it("wraps the account and stage tables in an overflow-x container", () => {
    expect(modelsAndProvidersHtml).toMatch(/<div style="overflow-x:auto">\s*<table class="tbl">\s*<thead>\s*<tr><th>Name<\/th><th>Agent/);
    expect(modelsAndProvidersHtml).toMatch(/<div style="overflow-x:auto">\s*<table class="tbl">\s*<thead>\s*<tr><th>Stage<\/th>/);
  });
  it("uses window.api/window.esc only", () => {
    const stripped = modelsAndProvidersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(modelsAndProvidersScript).not.toMatch(/\bvar\s+\w/);
  });
  it("offers Connect ChatGPT plan for codex-subscription rows, holding the code in memory only", () => {
    expect(modelsAndProvidersScript).toContain("Connect ChatGPT plan");
    expect(modelsAndProvidersScript).toContain("/chatgpt-pairing");
    expect(modelsAndProvidersScript).toMatch(/a\.authMode === 'codex-subscription' && a\.profileStatus === 'active' && mpCanEdit\(\)/);
    expect(modelsAndProvidersHtml).toContain('id="mp-pairing"');
    // The code renders as text content into its own element, never into the account rows or storage.
    expect(modelsAndProvidersScript).toContain("let mpPairing = null");
    expect(modelsAndProvidersScript).not.toMatch(/(localStorage|sessionStorage)/);
    const rows = modelsAndProvidersScript.slice(modelsAndProvidersScript.indexOf("function mpRenderAccounts"), modelsAndProvidersScript.indexOf("function mpAccountError"));
    expect(rows).not.toContain("mpPairing");
  });
  it("carries typed key values and focus across the account row rebuild, in the inputs only", () => {
    const fn = modelsAndProvidersScript.slice(modelsAndProvidersScript.indexOf("function mpRenderAccounts"), modelsAndProvidersScript.indexOf("function mpAccountError"));
    const read = fn.indexOf("input[data-key-for]");
    const rebuild = fn.indexOf("rowsEl.innerHTML = html");
    const restore = fn.indexOf("input[data-key-for]", rebuild);
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(rebuild);
    expect(restore).toBeGreaterThan(rebuild);
    expect(fn).toContain("inp.value = typed[id]");
    expect(fn).toContain(".focus()");
    expect(modelsAndProvidersScript).not.toMatch(/(localStorage|sessionStorage)/);
  });
});


describe.each(["claude-subscription", "openrouter-api-key"])("%s credentials", (authMode) => {
  it.each([true, false])("renders credential badges and readiness (admin=%s)", async (admin) => {
    const dom = new JSDOM(modelsAndProvidersHtml, { runScripts: "outside-only" });
    const win = dom.window;
    const profileId = `claude"'<img src=x>&`;
    const accounts = [true, false].map((credentialSet, i) => ({
      profileId: i === 0 ? profileId : "claude-empty",
      identity: "Claude subscription",
      agent: "claude",
      provider: authMode === "openrouter-api-key" ? "openrouter" : "anthropic",
      authMode,
      profileStatus: "active",
      credentialSet,
      account: {
        readiness: i === 0 ? "ready" : undefined,
        sessionRecovery: { state: "legacy-recovery-state", recoveryRequired: true },
      },
    }));
    win.isAdmin = () => admin;
    win.registerPage = () => {};
    win.esc = win.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    const api = vi.fn(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === `/api/model-accounts/${encodeURIComponent(profileId)}/credential`) {
        accounts[0].credentialSet = options?.method === "PUT";
        accounts[0].account.readiness = options?.method === "PUT" ? "ready" : "missing";
      }
      return {
        ok: true,
        json: async () => path === "/api/model-accounts" ? { accounts }
          : path === "/api/agent-defaults" ? { mode: "legacy", stages: {} } : {},
      };
    });
    win.api = api;
    try {
      // Attach the real delegated click handlers without starting the polling timer.
      let activate = () => {};
      win.registerPage = (_route: string, callback: () => void) => { activate = callback; };
      win.setInterval = (() => 0) as typeof win.setInterval;
      win.eval(modelsAndProvidersScript);
      activate();
      await win.loadModelsAndProviders();
      await vi.waitFor(() => expect(win.document.querySelectorAll("#mp-account-rows tr")).toHaveLength(2));
      expect(Array.from(win.document.querySelectorAll<HTMLSelectElement>('#mp-stage-rows select[data-field="accountProfileId"]')).every(select =>
        Array.from(select.options).some(option => option.value === profileId))).toBe(true);
      const rows = win.document.querySelectorAll<HTMLTableRowElement>("#mp-account-rows tr");
      const headers = rows[0].closest("table")!.querySelectorAll("th");
      expect(Array.from(headers, h => h.textContent)).not.toContain("Busy / recovery");
      for (const [i, row] of Array.from(rows).entries()) {
        expect(row.cells).toHaveLength(headers.length);
        expect(row.cells[5].textContent).toBe(i === 0 ? "ready" : "unknown");
        expect(row.cells[6].querySelector(".badge")?.textContent).toBe(i === 0 ? "set" : "not set");
        expect(row.textContent).not.toMatch(/legacy-recovery-state|recovery required|idle/);
        expect(row.querySelectorAll("input[type=password]")).toHaveLength(admin ? 1 : 0);
        expect(row.querySelectorAll("button[data-act]")).toHaveLength(admin ? 3 : 0);
      }
      expect(rows[0].cells[0].textContent).toBe("Claude subscription" + profileId + (admin ? "Edit" : ""));
      expect(rows[0].querySelector("img")).toBeNull();
      if (admin) {
        const input = rows[0].querySelector<HTMLInputElement>("input")!;
        expect(input.value).toBe("");
        expect(input.placeholder).toBe(authMode === "claude-subscription" ? "setup-token" : "API key");
        expect(input.getAttribute("data-key-for")).toBe(profileId);
        expect(rows[0].querySelector('[data-act="set-key"]')?.getAttribute("data-profile")).toBe(profileId);
        expect(rows[0].querySelector('[data-act="remove-key"]')?.textContent).toBe("Remove key");
        input.value = "unsubmitted-token";
        input.focus();
        await win.loadModelsAndProviders();
        await vi.waitFor(() => expect(win.document.querySelector("#mp-account-rows input")).not.toBe(input));
        expect(win.document.querySelector<HTMLInputElement>("#mp-account-rows input")?.value).toBe("unsubmitted-token");
        expect(win.document.activeElement?.getAttribute("data-key-for")).toBe(profileId);

        const credentialUrl = `/api/model-accounts/${encodeURIComponent(profileId)}/credential`;
        win.document.querySelector<HTMLButtonElement>('[data-act="set-key"]')!.click();
        await vi.waitFor(() => {
          expect(api).toHaveBeenCalledWith(credentialUrl, {
            method: "PUT", body: JSON.stringify({ apiKey: "unsubmitted-token" }),
          });
          expect(win.document.querySelector<HTMLInputElement>("#mp-account-rows input")?.value).toBe("");
        });
        win.document.querySelector<HTMLButtonElement>('[data-act="remove-key"]')!.click();
        await vi.waitFor(() => {
          expect(api).toHaveBeenCalledWith(credentialUrl, { method: "DELETE" });
          expect(win.document.querySelector("#mp-account-rows tr td:last-child .badge")?.textContent).toBe("not set");
          expect(win.document.querySelectorAll("#mp-account-rows tr td")[5].textContent).toBe("missing");
        });
        expect(win.document.body.innerHTML).not.toContain("unsubmitted-token");
      }
    } finally {
      win.close();
    }
  });
});

describe("account profile names and editing", () => {
  async function setup(admin = true) {
    const dom = new JSDOM(modelsAndProvidersHtml, { runScripts: "outside-only" });
    const win = dom.window;
    const account = { profileId: 'team"/<id>', identity: 'Team "<img src=x>"', profileStatus: "active", agent: "codex", provider: "openai", authMode: "openai-api-key" };
    let conflict = false;
    win.isAdmin = () => admin;
    win.esc = win.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    let activate = () => {};
    win.registerPage = (_route: string, callback: () => void) => { activate = callback; };
    win.setInterval = (() => 0) as typeof win.setInterval;
    const api = vi.fn(async (path: string, options?: { method?: string; body?: string }) => {
      if (options?.method === "PATCH") {
        const { status, ...fields } = JSON.parse(options.body!);
        Object.assign(account, fields, status ? { profileStatus: status } : {});
      }
      return { ok: !(conflict && options?.method === "POST"), status: 409, json: async () => conflict && options?.method === "POST" ? { error: "Profile already exists" } : path === "/api/model-accounts" ? { accounts: [account] } : { mode: "legacy", stages: {} } };
    });
    win.api = api;
    win.eval(modelsAndProvidersScript);
    activate();
    await vi.waitFor(() => expect(win.document.querySelectorAll("#mp-stage-rows tr")).toHaveLength(3));
    const click = (action: string) => win.document.querySelector<HTMLButtonElement>(`[data-act="${action}"]`)!.click();
    const change = (selector: string, value: string) => {
      const input = win.document.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    };
    return { win, account, api, click, change, setConflict: () => { conflict = true; } };
  }

  it("generates valid, bounded unique ids from names", async () => {
    const { win } = await setup();
    try {
      const generate = win.mpProfileIdFromName as (name: string, ids: string[]) => string;
      for (const [name, ids, expected] of [
        ["Team ChatGPT Plan", [], "team-chatgpt-plan"],
        ["Team ChatGPT Plan", ["team-chatgpt-plan"], "team-chatgpt-plan-2"],
        ["Team ChatGPT Plan", ["team-chatgpt-plan", "team-chatgpt-plan-2"], "team-chatgpt-plan-3"],
        ["!!!", [], "account"], ["._Name", [], "name"], ["._", [], "account"],
        ["A".repeat(100), [], "a".repeat(64)],
        ["A".repeat(100), ["a".repeat(64)], "a".repeat(62) + "-2"],
      ] as [string, string[], string][]) {
        const id = generate(name, ids);
        expect(id).toBe(expected);
        expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
        expect(id.length).toBeLessThanOrEqual(64);
      }
    } finally { win.close(); }
  });

  it("posts the Name with its generated id and displays a conflict message", async () => {
    const { win, api, change, setConflict } = await setup();
    try {
      expect(win.document.querySelectorAll('#mp-account-form input')).toHaveLength(1);
      change("#mp-new-name", "Team ChatGPT Plan");
      await win.mpAddAccount();
      expect(api).toHaveBeenCalledWith("/api/model-accounts", { method: "POST", body: JSON.stringify({ profileId: "team-chatgpt-plan", identity: "Team ChatGPT Plan", agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" }) });
      setConflict();
      change("#mp-new-name", "Team");
      await win.mpAddAccount();
      expect(win.document.querySelector("#mp-account-error")?.textContent).toContain("Profile already exists");
    } finally { win.close(); }
  });

  it.each(["claude", "codex"])("creates an OpenRouter profile for %s and preserves rejected combinations", async (agent) => {
    const { win, api, change, setConflict } = await setup();
    try {
      change("#mp-new-name", "Router");
      change("#mp-new-agent", agent);
      const provider = win.document.querySelector<HTMLSelectElement>("#mp-new-provider")!;
      const auth = win.document.querySelector<HTMLSelectElement>("#mp-new-authMode")!;
      const button = win.document.getElementById("mp-import-credential")!;
      expect(button.hidden).toBe(false);
      const select = (el: HTMLSelectElement, value: string) => {
        el.value = value;
        expect(el.value).toBe(value);
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
      };
      select(provider, "openrouter");
      expect(button.hidden).toBe(true);
      select(provider, "anthropic");
      expect(button.hidden).toBe(false);
      select(auth, "openrouter-api-key");
      expect(button.hidden).toBe(true);
      select(provider, "openrouter");
      await win.mpAddAccount();
      expect(api).toHaveBeenCalledWith("/api/model-accounts", {
        method: "POST", body: JSON.stringify({ profileId: "router", identity: "Router", agent, provider: "openrouter", authMode: "openrouter-api-key" }),
      });
      change("#mp-new-name", "Invalid");
      select(auth, "openai-api-key");
      setConflict();
      const originalApi = win.api;
      win.api = async (path: string, options?: { method?: string; body?: string }) =>
        options?.method === "POST" ? { ok: false, status: 400, json: async () => ({ error: "<b>Unsupported combination</b>" }) } : originalApi(path, options);
      await win.mpAddAccount();
      expect(win.document.getElementById("mp-account-error")!.textContent).toContain("<b>Unsupported combination</b>");
      expect(win.document.querySelector("#mp-account-error b")).toBeNull();
      expect(win.document.querySelector<HTMLInputElement>("#mp-new-name")!.value).toBe("Invalid");
      expect(win.document.querySelector<HTMLSelectElement>("#mp-new-agent")!.value).toBe(agent);
      expect(provider.value).toBe("openrouter");
      expect(auth.value).toBe("openai-api-key");
    } finally { win.close(); }
  });

  it("edits only changed fields, preserves drafts and stage edits, and cancels", async () => {
    const { win, api, account, click, change } = await setup();
    try {
      const table = win.document.querySelector("#mp-account-rows")!.closest("table")!;
      expect(Array.from(table.querySelectorAll("th"), h => h.textContent)).toEqual(["Name", "Agent", "Provider", "Authentication", "Status", "Readiness", "API key"]);
      expect(table.querySelector("td .mono")?.textContent).toBe(account.profileId);
      expect(table.querySelector("img")).toBeNull();
      click("edit-profile");
      expect(win.document.querySelector<HTMLInputElement>("[data-edit-name]")?.value).toBe(account.identity);
      expect(table.querySelector("img")).toBeNull();
      change("[data-edit-name]", "Renamed");
      await win.loadModelsAndProviders();
      await vi.waitFor(() => expect(win.document.querySelector<HTMLInputElement>("[data-edit-name]")?.value).toBe("Renamed"));
      change('[data-stage="planning"][data-field="model"]', "unsaved-model");
      click("save-profile");
      const url = `/api/model-accounts/${encodeURIComponent(account.profileId)}`;
      await vi.waitFor(() => {
        expect(api).toHaveBeenCalledWith(url, { method: "PATCH", body: JSON.stringify({ identity: "Renamed" }) });
        expect(table.querySelector("td")?.textContent).toContain("Renamed");
        expect(table.querySelector("[data-edit-name]")).toBeNull();
      });
      expect(win.document.querySelector<HTMLInputElement>('[data-stage="planning"][data-field="model"]')?.value).toBe("unsaved-model");
      click("edit-profile");
      change("[data-edit-status]", "disabled");
      click("save-profile");
      await vi.waitFor(() => {
        expect(api).toHaveBeenCalledWith(url, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) });
        expect(table.querySelector("td:nth-child(5) .badge")?.textContent).toBe("disabled");
      });
      const calls = api.mock.calls.length;
      click("edit-profile");
      change("[data-edit-name]", "Discard");
      click("cancel-profile");
      expect(api.mock.calls).toHaveLength(calls);
      expect(table.querySelector("td")?.textContent).toContain("Renamed");
    } finally { win.close(); }
  });

  it.each(["success", "server error", "network error"])("locks profile editing during a pending PATCH (%s)", async (outcome) => {
    const { win, api, click, change } = await setup();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = api.getMockImplementation()!;
    let patchCompleted = false;
    const refreshControls: boolean[] = [];
    api.mockImplementation(async (path, options) => {
      if (options?.method === "PATCH") {
        await pending;
        if (outcome === "network error") throw new Error("Connection lost");
        if (outcome === "server error") return { ok: false, status: 500, json: async () => ({ error: "Save failed" }) };
      }
      if (path === "/api/model-accounts" && patchCompleted) {
        win.document.querySelectorAll<HTMLInputElement>('[data-edit-name], [data-edit-status], [data-act="save-profile"], [data-act="cancel-profile"]').forEach(control => refreshControls.push(control.disabled));
      }
      const response = await original(path, options);
      if (options?.method === "PATCH") patchCompleted = true;
      return response;
    });
    try {
      click("edit-profile");
      change("[data-edit-name]", "Submitted name");
      change("[data-edit-status]", "disabled");
      click("save-profile");
      const assertLocked = () => {
        for (const selector of ["[data-edit-name]", "[data-edit-status]", '[data-act="save-profile"]', '[data-act="cancel-profile"]']) {
          expect(win.document.querySelector<HTMLInputElement>(selector)?.disabled).toBe(true);
        }
      };
      assertLocked();
      click("cancel-profile");
      click("save-profile");
      await win.loadModelsAndProviders();
      assertLocked();
      expect(api.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1);
      release();
      await vi.waitFor(() => {
        if (outcome === "success") {
          expect(refreshControls).toEqual([true, true, true, true]);
          expect(win.document.querySelector("[data-edit-name]")).toBeNull();
          expect(win.document.querySelector("#mp-account-rows td")?.textContent).toContain("Submitted name");
          expect(win.document.querySelector("#mp-account-rows td:nth-child(5) .badge")?.textContent).toBe("disabled");
        } else {
          const name = win.document.querySelector<HTMLInputElement>("[data-edit-name]")!;
          expect(name.disabled).toBe(false);
          expect(name.value).toBe("Submitted name");
          expect(win.document.querySelector<HTMLSelectElement>("[data-edit-status]")?.value).toBe("disabled");
          expect(win.document.querySelector<HTMLButtonElement>('[data-act="save-profile"]')?.disabled).toBe(false);
          expect(win.document.querySelector<HTMLSelectElement>("[data-edit-status]")?.disabled).toBe(false);
          expect(win.document.querySelector<HTMLButtonElement>('[data-act="cancel-profile"]')?.disabled).toBe(false);
          expect(win.document.querySelector("#mp-account-error")?.textContent).toContain(outcome === "server error" ? "Save failed" : "Failed to update account profile");
        }
      });
    } finally { release(); win.close(); }
  });

  it("preserves profile edit focus and Name selection across account refreshes", async () => {
    const { win, click, change } = await setup();
    try {
      click("edit-profile");
      change("[data-edit-name]", "Unsaved name");
      const name = win.document.querySelector<HTMLInputElement>("[data-edit-name]")!;
      name.focus();
      name.setSelectionRange(2, 7, "backward");
      await win.loadModelsAndProviders();
      const refreshed = win.document.querySelector<HTMLInputElement>("[data-edit-name]")!;
      expect(refreshed).not.toBe(name);
      expect(win.document.activeElement).toBe(refreshed);
      expect(refreshed.value).toBe("Unsaved name");
      expect([refreshed.selectionStart, refreshed.selectionEnd, refreshed.selectionDirection]).toEqual([2, 7, "backward"]);
      win.document.querySelector<HTMLSelectElement>("[data-edit-status]")!.focus();
      await win.loadModelsAndProviders();
      expect(win.document.activeElement).toBe(win.document.querySelector("[data-edit-status]"));
    } finally { win.close(); }
  });

  it("hides editing and the add form for non-admins", async () => {
    const { win } = await setup(false);
    try {
      expect(win.document.querySelector('[data-act="edit-profile"]')).toBeNull();
      expect(win.document.querySelector("#mp-account-form")?.classList.contains("hidden")).toBe(true);
    } finally { win.close(); }
  });
});

describe("Import orchestrator credential", () => {
  const profileId = `environment"'<img src=x>&`;
  const wrapped = (status: number, body: object) => ({ content: [{ type: "text", text: JSON.stringify({ status, body }) }] });

  async function fixture(admin: boolean, reply: object, ok = true, mode = "legacy") {
    const dom = new JSDOM(modelsAndProvidersHtml, { runScripts: "outside-only" });
    const win = dom.window;
    win.isAdmin = () => admin;
    win.esc = win.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    let activate = () => {};
    win.registerPage = (_route: string, callback: () => void) => { activate = callback; };
    win.setInterval = (() => 0) as typeof win.setInterval;
    let imported = false;
    const account = { profileId, identity: "Environment", agent: "claude", provider: "anthropic", authMode: "anthropic-api-key", profileStatus: "active" };
    const api = vi.fn(async (path: string, _options?: { method?: string; body?: string }) => {
      if (path === "/api/tools/import_environment_credential") {
        imported = true;
        return { ok, status: ok ? 200 : 503, json: async () => reply };
      }
      return { ok: true, json: async () => path === "/api/model-accounts" ? { accounts: imported ? [account] : [] }
        : path === "/api/agent-defaults" ? { mode, stages: {} } : {} };
    });
    win.api = api;
    win.eval(modelsAndProvidersScript);
    activate();
    await vi.waitFor(() => expect(win.document.querySelectorAll("#mp-stage-rows tr")).toHaveLength(3));
    api.mockClear();
    // outside-only scripts do not execute inline onclick attributes.
    const invoke = () => win.eval("mpImportCredential()");
    win.document.getElementById("mp-import-credential")!.addEventListener("click", invoke);
    return { win, api, invoke };
  }

  it("renders defaults active for configured and new projects without opt-in copy", async () => {
    const { win } = await fixture(true, {}, true, "configured");
    try {
      expect(win.document.body.textContent).toContain("Defaults are active for configured projects and for new projects");
      expect(win.document.body.textContent).not.toMatch(/opt in|opt-in|opts in|opted-in/i);
    } finally { win.close(); }
  });

  it.each([true, false])("shows the action only to admins and guards invocation (admin=%s)", async admin => {
    const { win, api, invoke } = await fixture(admin, wrapped(404, { error: "missing" }));
    try {
      const button = win.document.getElementById("mp-import-credential")!;
      expect(button.textContent).toBe("Import orchestrator credential");
      expect(button.closest("#mp-account-form")!.classList.contains("hidden")).toBe(!admin);
      expect(button.previousElementSibling?.textContent).toBe("Add account profile");
      expect(win.document.getElementById("mp-account-form")!.textContent).toContain("Legacy projects keep reading the environment variable until an admin changes their mode with set_project_agent_mode");
      if (!admin) { await invoke(); expect(api).not.toHaveBeenCalled(); }
    } finally { win.close(); }
  });

  it.each([201, 200])("refreshes accounts and preserves stage edits for inner status %s", async status => {
    const { win, api } = await fixture(true, wrapped(status, { profileId }));
    try {
      const input = win.document.querySelector<HTMLInputElement>('[data-stage="planning"][data-field="model"]')!;
      input.value = "unsaved-model";
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      win.document.getElementById("mp-import-credential")!.click();
      await vi.waitFor(() => expect(win.document.getElementById("mp-account-notice")!.textContent).toBe(`${profileId}: ${status === 201 ? "created" : "already imported"}`));
      expect(api.mock.calls.filter(([path]) => path === "/api/tools/import_environment_credential")).toEqual([
        ["/api/tools/import_environment_credential", { method: "POST", body: JSON.stringify({ args: {} }) }],
      ]);
      expect(api.mock.calls.filter(([path]) => path === "/api/model-accounts")).toHaveLength(1);
      expect(win.document.querySelector("#mp-account-rows td .mono")!.textContent).toBe(profileId);
      expect(win.document.querySelector<HTMLInputElement>('[data-stage="planning"][data-field="model"]')!.value).toBe("unsaved-model");
      expect(win.document.querySelector("img")).toBeNull();
      expect(win.document.getElementById("mp-account-notice")!.classList.contains("hidden")).toBe(false);
      expect(win.document.getElementById("mp-account-notice")!.classList.contains("text-tertiary")).toBe(true);
      expect(win.document.getElementById("mp-account-notice")!.classList.contains("error")).toBe(false);
      expect(win.document.getElementById("mp-account-error")!.textContent).toBe("");
    } finally { win.close(); }
  });

  it.each([
    [wrapped(404, { error: "no model credential in the environment" }), true, "no model credential in the environment"],
    [wrapped(409, { error: "conflict <img src=x>" }), true, "conflict <img src=x>"],
    [wrapped(503, { error: "unavailable" }), true, "unavailable"],
    [{ content: [{ type: "text", text: "forbidden: admin required" }] }, true, "forbidden: admin required"],
    [{ error: "HTTP failure <img src=x>" }, false, "HTTP failure <img src=x>"],
  ] as const)("shows failures without refreshing accounts (%j)", async (reply, ok, message) => {
    const { win, api, invoke } = await fixture(true, reply, ok);
    try {
      const before = win.document.getElementById("mp-account-rows")!.innerHTML;
      await invoke();
      expect(win.document.getElementById("mp-account-notice")!.textContent).toBe("");
      expect(win.document.getElementById("mp-account-error")!.textContent).toBe(message);
      expect(win.document.getElementById("mp-account-error")!.classList.contains("hidden")).toBe(false);
      expect(win.document.getElementById("mp-account-rows")!.innerHTML).toBe(before);
      expect(api).toHaveBeenCalledTimes(1);
      expect(win.document.querySelector("img")).toBeNull();
    } finally { win.close(); }
  });
});
