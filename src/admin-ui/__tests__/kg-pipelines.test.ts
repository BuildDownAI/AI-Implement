import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { kgPipelinesHtml, kgPipelinesScript } from "../pages/kg-pipelines.js";
import { deploymentsHtml, deploymentsScript } from "../pages/deployments.js";

describe("kg pipelines page", () => {
  it("is a hidden data-page section with its own message box", () => {
    expect(kgPipelinesHtml).toContain('<section data-page="kg-pipelines" hidden>');
    expect(kgPipelinesHtml).toContain('<div id="kg-pipelines-error" hidden></div>');
    expect(kgPipelinesHtml).toContain("Knowledge Graph Pipelines");
  });

  it("carries every card id, and Deployments carries none", () => {
    for (const id of ["kg-refresh-card", "kg-refresh-badge", "kg-refresh-stamp", "kg-refresh-last", "kg-sidecar-status", "kg-refresh-btn", "kg-accept-btn", "kg-cancel-btn", "kg-current-run", "kg-materialize-controls", "btn-kg-materialize-rdflib", "btn-kg-materialize-direct", "kg-materialize-source"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
      expect(deploymentsHtml).not.toContain(id);
    }
  });

  it("showMessage writes into #kg-pipelines-error, never #deployments-error", () => {
    expect(kgPipelinesScript).toContain("document.getElementById('kg-pipelines-error')");
    expect(kgPipelinesScript).not.toContain("deployments-error");
  });

  it("setBadge keeps the dot span", () => {
    expect(kgPipelinesScript).toContain('<span class="dot"></span>');
  });

  it("registers the page with both 15s pollers", () => {
    expect(kgPipelinesScript).toContain("setInterval(loadKgStatus, 15000)");
    expect(kgPipelinesScript).toContain("window.registerPage('kg-pipelines'");
  });

  it("leaves no KG card code on Deployments but keeps the deploy-side KG text", () => {
    expect(deploymentsScript).not.toContain("loadKgStatus");
    expect(deploymentsScript).not.toContain("loadKgMaterializeMode");
    expect(deploymentsScript).not.toContain("/api/kg/");
    expect(deploymentsScript).toContain("setInterval(loadDeployments, 30000)");
    expect(deploymentsScript).toContain("plural(w.count, 'KG ingest run')");
  });
});

describe("kg refresh card", () => {
  it("declares the kg-refresh element ids", () => {
    for (const id of ["kg-refresh-card", "kg-refresh-badge", "kg-refresh-stamp", "kg-refresh-last", "kg-refresh-btn", "kg-sidecar-status"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
  });

  it("renders the sidecar liveness state beside the stage badge and hides it before the first probe (AII-650)", () => {
    // The element ships hidden; the script shows the warning with the probe's lastError when the
    // sidecar is unavailable, a one-line "reachable" when a probe has run, and hides it otherwise.
    expect(kgPipelinesHtml).toContain('id="kg-sidecar-status" hidden');
    expect(kgPipelinesScript).toContain("const sidecarEl = document.getElementById('kg-sidecar-status')");
    expect(kgPipelinesScript).toContain("if (data.kgUnavailable) {");
    expect(kgPipelinesScript).toContain("'⚠️ KG sidecar not serving — ' + ((data.sidecar && data.sidecar.lastError) || 'unknown error')");
    expect(kgPipelinesScript).toContain("} else if (data.sidecar && data.sidecar.checkedAt) {");
    expect(kgPipelinesScript).toContain("sidecarEl.textContent = 'KG sidecar: reachable'");
    expect(kgPipelinesScript).toContain("sidecarEl.hidden = true");
  });

  it("calls /api/kg/status for status", () => {
    expect(kgPipelinesScript).toContain("/api/kg/status");
  });

  it("exposes triggerKgRefresh", () => {
    expect(kgPipelinesScript).toContain("window.triggerKgRefresh");
  });

  it("posts to /api/kg/refresh for the refresh trigger", () => {
    expect(kgPipelinesScript).toContain("window.api('/api/kg/refresh', { method: 'POST' })");
  });

  it("maps every stage to a badge via setBadge", () => {
    // Each new stage must pass through setBadge — a textContent write drops the dot span.
    for (const [kind, label] of [
      ["running", "checking"],
      ["running", "running"],   // ingest-running
      ["running", "landing"],   // snapshot-landed
      ["running", "staging"],
      ["ok", "serving"],
      ["warn", "awaiting decision"],
      ["warn", "reverted"],
      ["fail", "failed"],
      ["warn", "degraded"],     // kgDegraded fallback
      ["neutral", "stale"],     // ingest-needed fallback
    ] as const) {
      expect(kgPipelinesScript).toContain(`, '${kind}', '${label}')`);
    }
  });

  it("emits stage-specific progress text for each in-progress stage", () => {
    expect(kgPipelinesScript).toContain("Checking KG source repo for a newer snapshot");
    expect(kgPipelinesScript).toContain("Runner job dispatched");
    expect(kgPipelinesScript).toContain("waiting for snapshot commit");
    expect(kgPipelinesScript).toContain("Snapshot commit confirmed");
    expect(kgPipelinesScript).toContain("starting local staging");
    expect(kgPipelinesScript).toContain("Staging new graph overlay");
  });

  it("falls back to running:true for older responses without a stage field", () => {
    // Older orchestrators omit stage; the UI must not crash or show an empty badge.
    expect(kgPipelinesScript).toContain("data.stage || (data.running ? 'checking' : 'idle')");
  });

  it("disables the refresh button while running or deploy-held", () => {
    expect(kgPipelinesScript).toContain("!!data.running || !!data.deployHeld");
  });

  it("shows the 422 callback-unconfigured message as a warning, not an error", () => {
    // The 422 is an expected configuration gap, not a server fault.
    expect(kgPipelinesScript).toContain("res.status === 422 && body.precondition === 'callback-unconfigured'");
    expect(kgPipelinesScript).toContain("RUNNER_CALLBACK_BASE_URL");
    expect(kgPipelinesScript).toContain("RUNNER_TOKEN_SECRET");
  });

  it("shows a 409 deploy-held warning distinct from refresh-in-progress", () => {
    expect(kgPipelinesScript).toContain("body.error === 'deploy-in-progress'");
    expect(kgPipelinesScript).toContain("A deploy is in progress");
    expect(kgPipelinesScript).toContain("A refresh is already in progress.");
  });
});

describe("kg materialize-mode control (AII-602)", () => {
  it("declares the materialize control element ids", () => {
    for (const id of [
      "kg-materialize-controls",
      "btn-kg-materialize-rdflib",
      "btn-kg-materialize-direct",
      "kg-materialize-source",
    ]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
  });

  it("fetches /api/kg/materialize-mode for the current mode", () => {
    expect(kgPipelinesScript).toContain("/api/kg/materialize-mode");
  });

  it("posts direct: true/false to /api/kg/materialize-mode when toggled", () => {
    expect(kgPipelinesScript).toContain("window.setKgMaterializeDirect");
    expect(kgPipelinesScript).toContain("{ method: 'POST', body: JSON.stringify({ direct: direct }) }");
  });

  it("wires the rdflib and direct buttons to setKgMaterializeDirect with the right argument", () => {
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgMaterializeDirect(false)\"");
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgMaterializeDirect(true)\"");
  });

  it("has no env-pinned warning or disabled handling (AII-1109)", () => {
    expect(kgPipelinesHtml).not.toContain("kg-materialize-env-warning");
    expect(kgPipelinesScript).not.toContain("kg-materialize-env-warning");
    expect(kgPipelinesScript).not.toContain("envPinned");
  });

  it("registers loadKgMaterializeMode on page load and on a poll interval", () => {
    expect(kgPipelinesScript).toContain("loadKgMaterializeMode();");
    expect(kgPipelinesScript).toContain("setInterval(loadKgMaterializeMode, 15000)");
  });

  it("renders the runs table after the refresh card, filtered to kg-refresh", () => {
    for (const id of ["kglog-body", "kglog-time-type", "kglog-count", "kglog-empty"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
      expect(kgPipelinesHtml.indexOf(`id="${id}"`)).toBeGreaterThan(kgPipelinesHtml.indexOf('id="kg-refresh-card"'));
    }
    expect(kgPipelinesScript).toContain("if (window.createDispatchLog) window.createDispatchLog('kglog'");
    expect(kgPipelinesScript).toContain("e.phase === 'kg-refresh'");
  });
});

describe("kg fly machine profile control (AII-1116)", () => {
  type Reply = { status: number; body: unknown };
  const profile = { cpuKind: "performance", cpus: 2, memoryMb: 8192, idleTimeoutMs: 604800000, source: "profile" };

  function mount(opts: { flyMachine?: unknown; saveReply?: Reply }) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${kgPipelinesHtml}</body>`, {
      runScripts: "dangerously",
      url: "http://localhost/admin#kg-pipelines",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = dom.window as any;
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.esc = esc;
    win.escAttr = esc;
    win.registerPage = () => {};
    const calls: { url: string; body: unknown }[] = [];
    win.api = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/api/tools/get_kg_status") {
        const payload = { flyMachine: opts.flyMachine ?? profile };
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }) };
      }
      if (url === "/api/tools/set_fly_machine_profile") {
        const r = opts.saveReply ?? { status: 200, body: { content: [{ type: "text", text: "{}" }] } };
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const script = dom.window.document.createElement("script");
    script.textContent = kgPipelinesScript;
    dom.window.document.head.appendChild(script);
    const doc = dom.window.document;
    const el = (id: string) => doc.getElementById(id) as HTMLInputElement;
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { win, doc, el, calls, settle };
  }

  it("declares the controls", () => {
    for (const id of ["kg-fly-machine-controls", "btn-kg-fly-cpu-shared", "btn-kg-fly-cpu-performance", "kg-fly-cpus", "kg-fly-memory-mb", "kg-fly-idle-hours", "btn-kg-fly-save", "kg-fly-machine-effective"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
  });

  it("renders the effective line and the inputs from get_kg_status", async () => {
    const { win, el, calls, settle } = mount({});
    await win.loadKgFlyMachine();
    expect(calls[0]).toEqual({ url: "/api/tools/get_kg_status", body: { args: {} } });
    expect(el("kg-fly-machine-effective").textContent).toBe("next Fly run: performance, 2 CPU / 8192 MB, idle 7 d (profile)");
    expect(el("kg-fly-cpus").value).toBe("2");
    expect(el("kg-fly-memory-mb").value).toBe("8192");
    expect(el("kg-fly-idle-hours").value).toBe("168");
    expect(el("btn-kg-fly-cpu-performance").classList.contains("btn-primary")).toBe(true);
    expect(el("btn-kg-fly-save").disabled).toBe(true);
    await settle();
  });

  it("ends the line in (default) for a default profile", async () => {
    const { win, el } = mount({ flyMachine: { ...profile, source: "default" } });
    await win.loadKgFlyMachine();
    expect(el("kg-fly-machine-effective").textContent).toMatch(/\(default\)$/);
  });

  it("enables Save on change, disables it on revert, and posts only the changed field", async () => {
    const { win, el, calls, settle } = mount({});
    await win.loadKgFlyMachine();
    el("kg-fly-memory-mb").value = "4096";
    win.refreshKgFlyDirty();
    expect(el("btn-kg-fly-save").disabled).toBe(false);
    el("kg-fly-memory-mb").value = "8192";
    win.refreshKgFlyDirty();
    expect(el("btn-kg-fly-save").disabled).toBe(true);
    el("kg-fly-memory-mb").value = "4096";
    win.refreshKgFlyDirty();
    await win.saveKgFlyMachine();
    await settle();
    const save = calls.find((c) => c.url === "/api/tools/set_fly_machine_profile");
    expect(save?.body).toEqual({ args: { pipeline: "kg-refresh", memoryMb: 4096 } });
    expect(calls.filter((c) => c.url === "/api/tools/get_kg_status").length).toBe(2);
  });

  it("posts the idle hours as whole milliseconds and the cpu kind when it changes", async () => {
    const { win, el, calls } = mount({});
    await win.loadKgFlyMachine();
    el("kg-fly-idle-hours").value = "1.5";
    win.setKgFlyCpuKind("shared");
    await win.saveKgFlyMachine();
    const save = calls.find((c) => c.url === "/api/tools/set_fly_machine_profile");
    expect(save?.body).toEqual({ args: { pipeline: "kg-refresh", cpuKind: "shared", idleTimeoutMs: 5400000 } });
  });

  it("shows a 400 answer's error in #kg-pipelines-error", async () => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "memoryMb must be at least 2048 per CPU" } }) }] };
    const { win, el } = mount({ saveReply: { status: 200, body: wrapped } });
    await win.loadKgFlyMachine();
    el("kg-fly-memory-mb").value = "1024";
    win.refreshKgFlyDirty();
    await win.saveKgFlyMachine();
    expect(el("kg-pipelines-error").textContent).toContain("memoryMb must be at least 2048 per CPU");
    expect(el("kg-pipelines-error").hidden).toBe(false);
  });

  it("shows 'admin only' for a 403 and leaves the inputs alone", async () => {
    for (const reply of [
      { status: 403, body: { error: "forbidden" } },
      { status: 200, body: { isError: true, content: [{ type: "text", text: "forbidden: set_fly_machine_profile requires the admin role" }] } },
    ]) {
      const { win, el } = mount({ saveReply: reply });
      await win.loadKgFlyMachine();
      el("kg-fly-memory-mb").value = "4096";
      win.refreshKgFlyDirty();
      await win.saveKgFlyMachine();
      expect(el("kg-pipelines-error").textContent).toBe("admin only");
      expect(el("kg-fly-memory-mb").value).toBe("4096");
      expect(el("btn-kg-fly-save").disabled).toBe(false);
    }
  });

  it("shows 'profile unavailable (503)' on a failed read and leaves the inputs alone", async () => {
    const { win, el } = mount({});
    await win.loadKgFlyMachine();
    const before = el("kg-fly-memory-mb").value;
    win.api = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await win.loadKgFlyMachine();
    expect(el("kg-fly-machine-effective").textContent).toBe("next Fly run: profile unavailable (503)");
    expect(el("kg-fly-memory-mb").value).toBe(before);
    expect(el("btn-kg-fly-save").disabled).toBe(true);
  });

  it("does not overwrite edited inputs on a poll", async () => {
    const { win, el } = mount({});
    await win.loadKgFlyMachine();
    el("kg-fly-memory-mb").value = "4096";
    win.refreshKgFlyDirty();
    await win.loadKgFlyMachine();
    expect(el("kg-fly-memory-mb").value).toBe("4096");
  });
});

describe("kg backend control (AII-1218)", () => {
  function mount(executionMode: unknown) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${kgPipelinesHtml}</body>`, { runScripts: "dangerously", url: "http://localhost/admin#kg-pipelines" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = dom.window as any;
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.esc = esc;
    win.escAttr = esc;
    win.registerPage = () => {};
    win.api = async (url: string) => {
      if (url === "/api/tools/get_kg_status") {
        const payload = { executionMode, flyMachine: { cpuKind: "performance", cpus: 2, memoryMb: 8192, idleTimeoutMs: 604800000, source: "default" } };
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }) };
      }
      if (url === "/api/kg/execution-mode") return { ok: true, status: 200, json: async () => ({ mode: "fly-machines", source: "db" }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const script = dom.window.document.createElement("script");
    script.textContent = kgPipelinesScript;
    dom.window.document.head.appendChild(script);
    const doc = dom.window.document;
    return { win, text: (id: string) => doc.getElementById(id)!.textContent, hidden: (id: string) => (doc.getElementById(id) as HTMLElement).hidden, doc };
  }

  it("declares the Backend buttons wired to setKgExecutionMode, and fetches the endpoint", () => {
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgExecutionMode('github-actions')\"");
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgExecutionMode('fly-machines')\"");
    for (const id of ["btn-kg-backend-gha", "btn-kg-backend-fly", "kg-backend-source", "kg-backend-effective"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
    expect(kgPipelinesScript).toContain("/api/kg/execution-mode");
  });

  it("paints the buttons and source from GET /api/kg/execution-mode", async () => {
    const { win, doc, text } = mount({ effective: "fly-machines", source: "kg-setting", setting: "fly-machines" });
    await win.loadKgExecutionMode();
    expect(doc.getElementById("btn-kg-backend-fly")!.classList.contains("btn-primary")).toBe(true);
    expect(doc.getElementById("btn-kg-backend-gha")!.classList.contains("btn-primary")).toBe(false);
    expect(text("kg-backend-source")).toBe("(db)");
  });

  it("shows the Fly rows when the effective backend is Fly", async () => {
    const { win, text, hidden } = mount({ effective: "fly-machines", source: "kg-setting", setting: "fly-machines" });
    await win.loadKgFlyMachine();
    expect(hidden("kg-fly-machine-controls")).toBe(false);
    expect(hidden("kg-fly-machine-effective")).toBe(false);
    expect(text("kg-backend-effective")).toBe("next run: Fly machines (KG setting)");
  });

  it("hides the Fly rows when the effective backend is GitHub Actions", async () => {
    const { win, hidden } = mount({ effective: "github-actions", source: "kg-setting", setting: "github-actions" });
    await win.loadKgFlyMachine();
    expect(hidden("kg-fly-machine-controls")).toBe(true);
    expect(hidden("kg-fly-machine-effective")).toBe(true);
  });

  it.each([
    [{ effective: "fly-machines", source: "runner-mode", setting: "fly-machines" }, "next run: Fly machines (runner mode fly)"],
    [{ effective: "github-actions", source: "runner-mode", setting: "fly-machines" }, "next run: GitHub Actions (runner mode gha overrides the KG setting)"],
    [{ effective: "github-actions", source: "fly-unconfigured", setting: "fly-machines" }, "next run: GitHub Actions (Fly not configured)"],
  ])("names the source on the effective line: %j", async (em, line) => {
    const { win, text } = mount(em);
    await win.loadKgFlyMachine();
    expect(text("kg-backend-effective")).toBe(line);
  });
});

describe("kg current run card (AII-1260)", () => {
  type Run = { triggerId: string; step: string | null; decisions: string[]; held: unknown };
  const held = {
    snapshotPr: 7,
    snapshotPrUrl: "https://github.com/o/kg/pull/7",
    decideBy: 1760000000000,
    partTable: [{ part: "<img src=x onerror=alert(1)>", prev: "100", new: "40" }],
  };

  function mount(opts: { currentRun: Run | null; stage?: string; statusOk?: boolean; decideReply?: unknown; confirm?: boolean; deployPolls?: number }) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${kgPipelinesHtml}</body>`, { runScripts: "dangerously", url: "http://localhost/admin#kg-pipelines" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = dom.window as any;
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.esc = esc;
    win.escAttr = esc;
    win.safeUrl = (u: string) => (/^https?:/.test(u) ? u : "#");
    win.confirm = () => opts.confirm ?? true;
    win.registerPage = () => {};
    const calls: { url: string; body: unknown }[] = [];
    win.api = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/api/kg/status") {
        if (opts.deployPolls && opts.deployPolls-- > 0) return { ok: false, status: 409, json: async () => ({ error: "deploy-in-progress" }) };
        if (opts.statusOk === false) return { ok: false, status: 500, json: async () => ({}) };
        const stage = opts.stage ?? (opts.currentRun ? "ingest-running" : "serving");
        return { ok: true, status: 200, json: async () => ({ stage, servedStamp: "abc", lastRefresh: null, currentRun: opts.currentRun }) };
      }
      if (url === "/api/tools/decide_kg_refresh") {
        return { ok: true, status: 200, json: async () => opts.decideReply ?? { content: [{ type: "text", text: "{}" }] } };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const script = dom.window.document.createElement("script");
    script.textContent = kgPipelinesScript;
    dom.window.document.head.appendChild(script);
    const doc = dom.window.document;
    const visibleButtons = () =>
      ["kg-refresh-btn", "kg-accept-btn", "kg-cancel-btn"]
        .map((id) => doc.getElementById(id) as HTMLElement)
        .filter((b) => !(b as HTMLElement).hidden)
        .map((b) => (b.textContent ?? "").trim());
    return { win, doc, calls, visibleButtons };
  }

  it("no current run: stamp, last outcome and Refresh graph now only", async () => {
    const { win, doc, visibleButtons } = mount({ currentRun: null });
    await win.loadKgStatus();
    expect(doc.getElementById("kg-refresh-stamp")?.textContent).toBe("Served graph stamp: abc");
    expect(doc.getElementById("kg-refresh-last")?.textContent).toBe("No refresh has run since boot.");
    expect(visibleButtons()).toEqual(["Refresh graph now"]);
    expect((doc.getElementById("kg-current-run") as HTMLElement).hidden).toBe(true);
  });

  it("links the current run to the Restate UI, and idle has no link", async () => {
    const m = mount({ currentRun: { triggerId: "trg/1", step: "ingest", decisions: [], held: null } });
    await m.win.loadKgStatus();
    const a = m.doc.querySelector("#kg-current-run a") as HTMLAnchorElement;
    expect(a.textContent).toBe("Open in Restate UI");
    expect(a.getAttribute("href")).toBe("/ui/workflows/KgRefresh/trg%2F1");
    const idle = mount({ currentRun: null });
    await idle.win.loadKgStatus();
    expect(idle.doc.querySelector("#kg-current-run a")).toBeNull();
  });

  it("run in flight: the step and Cancel only, never printing null", async () => {
    const m = mount({ currentRun: { triggerId: "t", step: "<b>ingest</b>", decisions: [], held: null } });
    await m.win.loadKgStatus();
    expect(m.doc.getElementById("kg-current-run")?.firstChild?.textContent).toBe("Run in flight: <b>ingest</b>");
    expect(m.doc.querySelector("#kg-current-run b")).toBeNull();
    expect(m.visibleButtons()).toEqual(["Cancel"]);
    const n = mount({ currentRun: { triggerId: "t", step: null, decisions: [], held: null } });
    await n.win.loadKgStatus();
    expect(n.doc.getElementById("kg-current-run")?.firstChild?.textContent).toBe("Run in flight");
  });

  it("held run: deadline, part table, PR link, Accept and Cancel", async () => {
    const m = mount({ currentRun: { triggerId: "t", step: "decision", decisions: ["accept", "cancel"], held }, stage: "awaiting-decision" });
    await m.win.loadKgStatus();
    const cur = m.doc.getElementById("kg-current-run") as HTMLElement;
    expect(cur.textContent).toContain("Held for a decision until ");
    expect(Array.from(cur.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["part", "previous", "new", "delta"]);
    expect(Array.from(cur.querySelectorAll("td")).map((t) => t.textContent)).toEqual(["<img src=x onerror=alert(1)>", "100", "40", "-60"]);
    expect(cur.querySelector("img")).toBeNull();
    expect(cur.querySelector("a[href^=\"https\"]")?.getAttribute("href")).toBe("https://github.com/o/kg/pull/7");
    expect(m.visibleButtons()).toEqual(["Accept new baseline & refresh", "Cancel"]);
    expect(m.doc.getElementById("kg-refresh-badge")?.textContent).toContain("awaiting decision");
  });

  it("re-enables Accept and Cancel after a deploy-in-progress poll", async () => {
    const m = mount({ currentRun: { triggerId: "t", step: "decision", decisions: ["accept", "cancel"], held }, stage: "awaiting-decision", deployPolls: 1 });
    await m.win.loadKgStatus();
    expect((m.doc.getElementById("kg-accept-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((m.doc.getElementById("kg-cancel-btn") as HTMLButtonElement).disabled).toBe(true);
    await m.win.loadKgStatus();
    expect((m.doc.getElementById("kg-accept-btn") as HTMLButtonElement).disabled).toBe(false);
    expect((m.doc.getElementById("kg-cancel-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("status failure hides the card", async () => {
    const m = mount({ currentRun: null, statusOk: false });
    await m.win.loadKgStatus();
    expect((m.doc.getElementById("kg-refresh-card") as HTMLElement).hidden).toBe(true);
  });

  it("posts the exact decision bodies and reloads the status", async () => {
    const m = mount({ currentRun: { triggerId: "t", step: "decision", decisions: ["accept", "cancel"], held }, stage: "awaiting-decision" });
    await m.win.decideKgRefresh("accept");
    await m.win.decideKgRefresh("cancel");
    const posts = m.calls.filter((c) => c.url === "/api/tools/decide_kg_refresh");
    expect(posts.map((c) => c.body)).toEqual([{ args: { action: "accept" } }, { args: { action: "cancel" } }]);
    expect(m.calls.filter((c) => c.url === "/api/kg/status")).toHaveLength(2);
  });

  it("a declined confirm makes no call", async () => {
    const m = mount({ currentRun: null, confirm: false });
    await m.win.decideKgRefresh("cancel");
    expect(m.calls).toEqual([]);
  });

  it("shows a tool error such as already-decided", async () => {
    const m = mount({
      currentRun: { triggerId: "t", step: "decision", decisions: ["accept", "cancel"], held },
      decideReply: { isError: true, content: [{ type: "text", text: "already-decided" }] },
    });
    await m.win.decideKgRefresh("accept");
    const err = m.doc.getElementById("kg-pipelines-error") as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain("already-decided");
  });

  it("the page source drops the dry-run and trigger-time accept code", () => {
    const src = kgPipelinesHtml + kgPipelinesScript;
    for (const gone of ["kg-dry-run-btn", "kg-accept-baseline-btn", "kg-dry-run-last", "renderKgDryRun", "lastDryRun", "triggerKgAcceptBaseline"]) {
      expect(src).not.toContain(gone);
    }
  });
});
