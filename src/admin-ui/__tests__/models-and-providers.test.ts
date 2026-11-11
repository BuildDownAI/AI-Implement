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
  it("drops the blanket repo-front-matter claim and explains opt-in", () => {
    expect(modelsAndProvidersHtml).not.toContain("Edit the model itself in the target repo");
    expect(modelsAndProvidersHtml).not.toContain("not in the orchestrator");
    expect(modelsAndProvidersHtml).toContain("Projects opt in separately");
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


describe("Claude subscription credentials", () => {
  it.each([true, false])("renders credential badges and readiness (admin=%s)", async (admin) => {
    const dom = new JSDOM(modelsAndProvidersHtml, { runScripts: "outside-only" });
    const win = dom.window;
    const profileId = `claude"'<img src=x>&`;
    const accounts = [true, false].map((credentialSet, i) => ({
      profileId: i === 0 ? profileId : "claude-empty",
      identity: "Claude subscription",
      agent: "claude",
      provider: "anthropic",
      authMode: "claude-subscription",
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
        expect(input.placeholder).toBe("setup-token");
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
      if (options?.method === "PATCH") Object.assign(account, JSON.parse(options.body!).status ? { profileStatus: JSON.parse(options.body!).status } : JSON.parse(options.body!));
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

  it("hides editing and the add form for non-admins", async () => {
    const { win } = await setup(false);
    try {
      expect(win.document.querySelector('[data-act="edit-profile"]')).toBeNull();
      expect(win.document.querySelector("#mp-account-form")?.classList.contains("hidden")).toBe(true);
    } finally { win.close(); }
  });
});
