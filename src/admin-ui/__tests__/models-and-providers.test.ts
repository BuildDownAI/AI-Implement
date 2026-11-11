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
      "mp-new-profileId": "Profile ID",
      "mp-new-identity": "Identity",
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
    expect(modelsAndProvidersHtml).toMatch(/<div style="overflow-x:auto">\s*<table class="tbl">\s*<thead>\s*<tr><th>Profile<\/th><th>Identity/);
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
        expect(row.cells[6].textContent).toBe(i === 0 ? "ready" : "unknown");
        expect(row.cells[7].querySelector(".badge")?.textContent).toBe(i === 0 ? "set" : "not set");
        expect(row.textContent).not.toMatch(/legacy-recovery-state|recovery required|idle/);
        expect(row.querySelectorAll("input[type=password]")).toHaveLength(admin ? 1 : 0);
        expect(row.querySelectorAll("button[data-act]")).toHaveLength(admin ? 2 : 0);
      }
      expect(rows[0].cells[0].textContent).toBe(profileId);
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
          expect(win.document.querySelectorAll("#mp-account-rows tr td")[6].textContent).toBe("missing");
        });
        expect(win.document.body.innerHTML).not.toContain("unsubmitted-token");
      }
    } finally {
      win.close();
    }
  });
});

describe("Import orchestrator credential", () => {
  const profileId = `environment"'<img src=x>&`;
  const wrapped = (status: number, body: object) => ({ content: [{ type: "text", text: JSON.stringify({ status, body }) }] });

  async function fixture(admin: boolean, reply: object, ok = true) {
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
        : path === "/api/agent-defaults" ? { mode: "legacy", stages: {} } : {} };
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

  it.each([true, false])("shows the action only to admins and guards invocation (admin=%s)", async admin => {
    const { win, api, invoke } = await fixture(admin, wrapped(404, { error: "missing" }));
    try {
      const button = win.document.getElementById("mp-import-credential")!;
      expect(button.textContent).toBe("Import orchestrator credential");
      expect(button.closest("#mp-account-form")!.classList.contains("hidden")).toBe(!admin);
      expect(button.previousElementSibling?.textContent).toBe("Add account profile");
      expect(win.document.getElementById("mp-account-form")!.textContent).toContain("Legacy projects keep reading the environment variable until they opt in");
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
      await vi.waitFor(() => expect(win.document.getElementById("mp-account-error")!.textContent).toBe(`${profileId}: ${status === 201 ? "created" : "already imported"}`));
      expect(api.mock.calls.filter(([path]) => path === "/api/tools/import_environment_credential")).toEqual([
        ["/api/tools/import_environment_credential", { method: "POST", body: JSON.stringify({ args: {} }) }],
      ]);
      expect(api.mock.calls.filter(([path]) => path === "/api/model-accounts")).toHaveLength(1);
      expect(win.document.querySelector("#mp-account-rows td")!.textContent).toBe(profileId);
      expect(win.document.querySelector<HTMLInputElement>('[data-stage="planning"][data-field="model"]')!.value).toBe("unsaved-model");
      expect(win.document.querySelector("img")).toBeNull();
      expect(win.document.getElementById("mp-account-error")!.classList.contains("hidden")).toBe(false);
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
      expect(win.document.getElementById("mp-account-error")!.textContent).toBe(message);
      expect(win.document.getElementById("mp-account-error")!.classList.contains("hidden")).toBe(false);
      expect(win.document.getElementById("mp-account-rows")!.innerHTML).toBe(before);
      expect(api).toHaveBeenCalledTimes(1);
      expect(win.document.querySelector("img")).toBeNull();
    } finally { win.close(); }
  });
});
