import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { pipelinesHtml, pipelinesScript } from "../pages/pipelines.js";
import { kgPipelinesHtml } from "../pages/kg-pipelines.js";
import { drawerHtml, drawerScript } from "../drawer.js";
import { componentsCss } from "../components.js";
import { localJobLogsHtml, localJobLogsScript } from "../local-job-logs.js";

const job = {
  id: 396, issueId: "filesystem:SAN2:SAN2-002", issueIdentifier: "SAN2-002",
  phase: "implementation", dispatchNumber: 1, executionMode: "local-docker",
  runnerMode: "local", machineId: "a".repeat(64), status: "running", dispatchedAt: Date.now(),
};

async function setup(entries: Array<typeof job & { trigger?: string | null; prUrl?: string }> = [job], logsStatus = 200) {
  const dom = new JSDOM(pipelinesHtml + localJobLogsHtml, { runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const api = vi.fn(async (url: string) => ({
    ok: url.startsWith("/api/log?") || logsStatus === 200,
    status: url.startsWith("/api/log?") ? 200 : logsStatus,
    json: async () => url.startsWith("/api/log?") ? entries : { logs: "saved runner output", source: "saved" },
  }));
  window.api = api;
  window.esc = (value: unknown) => {
    const el = window.document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  };
  window.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  window.safeUrl = (value: string) => value;
  window.isAdmin = () => true;
  window.registerPage = vi.fn();
  window.setLastUpdated = vi.fn();
  window.openJobDrawer = vi.fn();
  window.eval(localJobLogsScript);
  window.eval(pipelinesScript);
  await window.loadLog();
  return { dom, window, api, document: window.document };
}

describe("pipeline list log actions", () => {
  it.each([200, 404])("opens the local viewer from a row click (logs response %s)", async status => {
    const { dom, document, window, api } = await setup([job], status);
    try {
      (document.querySelector("#log-body button") as HTMLElement).click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/jobs/396/logs"));
      expect(document.querySelector("#local-job-logs-dialog")?.hasAttribute("open")).toBe(true);
      expect(window.openJobDrawer).not.toHaveBeenCalled();
      expect(api.mock.calls.some(([url]) => url.startsWith("/api/sessions/"))).toBe(false);
      if (status === 200) {
        await vi.waitFor(() => expect(document.getElementById("local-job-logs-output")?.textContent).toBe("saved runner output"));
      } else {
        await vi.waitFor(() => expect(document.getElementById("local-job-logs-error")?.textContent).toContain("Logs are unavailable"));
      }
    } finally { dom.window.close(); }
  });

  it("retains the Fly machine log action", async () => {
    const { dom, document, api } = await setup([{ ...job, executionMode: "fly-machines", runnerMode: "fly", machineId: "fly123" }]);
    try {
      (document.querySelector("#log-body button") as HTMLElement).click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/sessions/fly123/logs"));
      await vi.waitFor(() => expect(document.querySelector(".ml-content")?.textContent).toBe("saved runner output"));
    } finally { dom.window.close(); }
  });

  it("opens implementation logs when planning and implementation share a row", async () => {
    const { dom, document, api } = await setup([
      { ...job, dispatchNumber: 2 },
      { ...job, id: 395, phase: "planning", status: "completed" },
    ]);
    try {
      expect(document.querySelectorAll("#log-body tr")).toHaveLength(1);
      const button = document.querySelector("#log-body button") as HTMLElement;
      expect(button).not.toBeNull();
      button.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/jobs/396/logs"));
    } finally { dom.window.close(); }
  });
});

describe("dispatch PR link escaping", () => {
  it.each([false, true])("keeps an attacker-controlled URL inside href (grouped: %s)", async grouped => {
    const prUrl = 'https://github.com/org/repo/pull/1?x=\" onmouseover=\"alert(1)&other=\'value\'';
    const implementation = { ...job, machineId: "", prUrl, dispatchNumber: grouped ? 2 : 1 };
    const entries = grouped
      ? [implementation, { ...job, id: 395, phase: "planning", dispatchNumber: 1 }]
      : [implementation];
    const { dom, document } = await setup(entries);
    try {
      expect(document.querySelectorAll("#log-body tr")).toHaveLength(1);
      const cell = document.querySelector("#log-body tr")!.children[9];
      const link = cell.querySelector("a")!;
      expect(link.textContent).toBe("View");
      expect(link.getAttribute("href")).toBe(prUrl);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttributeNames().sort()).toEqual(["href", "target"]);
      expect(cell.querySelectorAll("a")).toHaveLength(1);
      expect(document.querySelector("#log-body [onmouseover]")).toBeNull();
    } finally { dom.window.close(); }
  });
});

describe("dispatch log instances", () => {
  const rows = [
    { ...job, id: 1, issueId: "i1", phase: "implement", dispatchNumber: 2, status: "completed", machineId: undefined },
    { ...job, id: 2, issueId: "i1", phase: "planning", dispatchNumber: 1, status: "completed", machineId: undefined },
    { ...job, id: 3, issueId: "kg", phase: "kg-refresh", executionMode: "fly-machines", machineId: "kgm1", status: "running" },
  ];

  async function setupTwo() {
    const dom = new JSDOM(pipelinesHtml + kgPipelinesHtml, { runScripts: "outside-only" });
    const { window } = dom;
    const api = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => url.startsWith("/api/log?") ? rows : {},
    }));
    window.api = api;
    window.esc = window.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    window.safeUrl = (value: string) => value;
    window.isAdmin = () => true;
    window.registerPage = vi.fn();
    window.eval(pipelinesScript);
    return { dom, window, api, document: window.document };
  }

  it("filters before grouping when a filter is given, and groups without one", async () => {
    const { dom, window, document } = await setupTwo();
    try {
      await window.createDispatchLog("kglog", { filter: (e: { phase: string }) => e.phase === "kg-refresh" }).load();
      const kgRows = document.querySelectorAll("#kglog-body tr");
      expect(kgRows).toHaveLength(1);
      expect(kgRows[0].querySelector(".badge")?.textContent).toBe("kg");
      await window.loadLog();
      expect(document.querySelectorAll("#log-body tr")).toHaveLength(2);
    } finally { dom.window.close(); }
  });

  it("each instance writes only to its own elements", async () => {
    const { dom, window, document } = await setupTwo();
    try {
      const kg = window.createDispatchLog("kglog", { filter: (e: { phase: string }) => e.phase === "kg-refresh" });
      await kg.load();
      expect(document.getElementById("log-body")?.children).toHaveLength(0);
      expect(document.getElementById("log-count")?.textContent).toBe("—");
      expect(document.getElementById("kglog-count")?.textContent).toContain("1 job");
    } finally { dom.window.close(); }
  });

  it("Stop on an in-flight kg-refresh row confirms, then DELETEs the session", async () => {
    const { dom, window, document, api } = await setupTwo();
    try {
      window.confirm = () => true;
      const kg = window.createDispatchLog("kglog", { filter: (e: { phase: string }) => e.phase === "kg-refresh" });
      await kg.load();
      const stop = document.querySelector("#kglog-body [data-cancel-id]") as HTMLElement;
      expect(document.querySelector("#kglog-body [data-machine-id]")).not.toBeNull();
      stop.click();
      await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/sessions/kgm1", { method: "DELETE" }));
    } finally { dom.window.close(); }
  });

  it("defaults both instances to a 7 day relative window, so /api/log gets since", async () => {
    const { dom, window, api } = await setupTwo();
    try {
      await window.createDispatchLog("kglog").load();
      expect(api.mock.calls[0][0]).toMatch(/^\/api\/log\?since=\d+$/);
    } finally { dom.window.close(); }
  });
});

describe("dispatch table accessibility", () => {
  it("wraps Jobs and KG tables with the shared horizontal scroller", () => {
    const dom = new JSDOM(pipelinesHtml + kgPipelinesHtml);
    for (const prefix of ["log", "kglog"]) {
      const body = dom.window.document.getElementById(prefix + "-body");
      expect(body?.closest("table")?.parentElement?.className).toBe("tbl-scroll");
    }
    expect(componentsCss).toContain(".tbl-scroll { max-width: 100%; overflow-x: auto; }");
    expect(componentsCss).toContain(".tbl-scroll .tbl th, .tbl-scroll .tbl td { white-space: nowrap; }");
    dom.window.close();
  });

  it("opens the implementation with the planning id and inferred status", async () => {
    const { dom, document, window } = await setup([
      { ...job, dispatchNumber: 2 },
      { ...job, id: 395, phase: "planning", status: "unknown" },
    ]);
    try {
      (document.querySelector("#log-body td") as HTMLElement).click();
      expect(window.openJobDrawer).toHaveBeenCalledWith(396, 395, "completed");
    } finally { dom.window.close(); }
  });
});


describe("grouped row drawer integration", () => {
  const implementation = {
    ...job, dispatchNumber: 2, dispatchedAt: Date.UTC(2026, 10, 15, 14),
    issueTitle: "Implement the issue", teamKey: "SAN2", repo: "org/repo",
    issueState: "In progress", sessionImage: "registry.example/impl:latest",
    restate: null,
  };
  const planning = {
    ...implementation, id: 395, phase: "planning", dispatchNumber: 1,
    dispatchedAt: Date.UTC(2026, 10, 14, 9), status: "completed",
    executionMode: "github-actions", runnerMode: "gha", machineId: "",
    issueTitle: "Plan the issue",
  };

  async function mount(admin = true) {
    const dom = new JSDOM(pipelinesHtml + drawerHtml, { runScripts: "outside-only" });
    const { window } = dom;
    const api = vi.fn(async (url: string) => {
      let body: unknown;
      if (url.startsWith("/api/log?")) body = [implementation, planning];
      else if (url === "/api/mappings") body = {};
      else if (url === "/api/jobs/396/steps") body = { job: implementation, steps: [] };
      else if (url === "/api/jobs/395/steps") body = { job: planning, steps: [] };
      else throw new Error("Unexpected request: " + url);
      return { ok: true, status: 200, json: async () => body };
    });
    window.api = api;
    window.esc = window.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    window.safeUrl = (value: string) => value;
    window.isAdmin = () => admin;
    window.registerPage = vi.fn();
    window.setLastUpdated = vi.fn();
    window.eval(pipelinesScript);
    window.eval(drawerScript);
    await window.loadLog();
    return { window, document: window.document, api };
  }

  it("opens implementation, preserves its planning association on refresh, and opens distinct planning metadata", async () => {
    const { window, document, api } = await mount();
    const field = (label: string) => Array.from(document.querySelectorAll("#drawer-context .field"))
      .find(el => el.querySelector(".field-label")?.textContent === label)?.lastElementChild?.textContent;
    const assertImplementation = () => {
      expect(document.getElementById("drawer-title")?.textContent).toBe(implementation.issueTitle);
      expect(document.getElementById("drawer-meta")?.textContent).toContain(new Date(implementation.dispatchedAt).toLocaleString());
      expect(field("Dispatch #")).toBe("2");
      expect(field("Phase")).toBe("implementation");
      expect(field("Runner")).toBe("local-docker (local)");
      expect(document.getElementById("drawer-planning-job")?.textContent).toContain("completed");
    };
    try {
      expect(document.querySelectorAll("#log-body tr")).toHaveLength(1);
      (document.querySelector("#log-body td") as HTMLElement).click();
      await vi.waitFor(assertImplementation);
      expect(api).toHaveBeenCalledWith("/api/jobs/396/steps");
      expect(api).not.toHaveBeenCalledWith("/api/jobs/395/steps");
      expect(document.getElementById("drawer-issue-row")?.textContent).toContain("running");
      await window.refreshJobDrawer(396, { background: true });
      assertImplementation();

      document.getElementById("drawer-planning-job")!.click();
      await vi.waitFor(() => expect(document.getElementById("drawer-title")?.textContent).toBe(planning.issueTitle));
      expect(api).toHaveBeenCalledWith("/api/jobs/395/steps");
      expect(document.getElementById("drawer-meta")?.textContent).toContain(new Date(planning.dispatchedAt).toLocaleString());
      expect(document.getElementById("drawer-meta")?.textContent).not.toContain(new Date(implementation.dispatchedAt).toLocaleString());
      expect(field("Dispatch #")).toBe("1");
      expect(field("Phase")).toBe("planning");
      expect(field("Runner")).toBe("github-actions (gha)");
      expect(document.getElementById("drawer-planning-job")).toBeNull();
      await window.refreshJobDrawer(395, { background: true });
      expect(field("Dispatch #")).toBe("1");
      expect(document.getElementById("drawer-planning-job")).toBeNull();

      // Returning via the row restores the association; opening an ungrouped job clears it.
      (document.querySelector("#log-body td") as HTMLElement).click();
      await vi.waitFor(assertImplementation);
      await window.openJobDrawer(396);
      expect(field("Phase")).toBe("implementation");
      expect(document.getElementById("drawer-planning-job")).toBeNull();
    } finally { window.closeJobDrawer(); window.close(); }
  });

  it("does not open a drawer or request admin endpoints when a user clicks the grouped row", async () => {
    const { window, document, api } = await mount(false);
    try {
      const open = vi.spyOn(window, "openJobDrawer");
      (document.querySelector("#log-body td") as HTMLElement).click();
      expect(open).not.toHaveBeenCalled();
      expect(document.getElementById("job-drawer-wrap")?.hasAttribute("hidden")).toBe(true);
      expect(api.mock.calls.every(([url]) => url.startsWith("/api/log?"))).toBe(true);
    } finally { window.close(); }
  });
});

describe("recurring dispatch presentation", () => {
  it.each([1, 21])("renders KG run #%s with only recognized trigger badges", async dispatchNumber => {
    for (const trigger of ["schedule", "manual", null, undefined, '<img src=x onerror="alert(1)">']) {
      const { dom, window, document } = await setup([{ ...job, phase: "kg-refresh", dispatchNumber, trigger }]);
      try {
        document.body.insertAdjacentHTML("beforeend", kgPipelinesHtml);
        await window.createDispatchLog("kglog", { filter: (e: { phase: string }) => e.phase === "kg-refresh" }).load();
        for (const prefix of ["log", "kglog"]) {
          const row = document.querySelector(`#${prefix}-body tr`)!;
          expect(row.classList.contains("redispatch-row")).toBe(false);
          expect(row.children[1].textContent).toBe(`run #${dispatchNumber}`);
          expect(row.children[1].querySelector("span")).toBeNull();
          expect(row.children[2].textContent).toBe("KG refresh" + (trigger === "schedule" ? " scheduled" : trigger === "manual" ? " manual" : ""));
          expect(row.children[2].querySelectorAll(".badge")).toHaveLength(trigger === "schedule" || trigger === "manual" ? 1 : 0);
          expect(row.children[2].querySelector("img")).toBeNull();
          expect(row.children[3].textContent).toBe("—");
          expect(row.children[4].textContent).toBe("—");
        }
      } finally { dom.window.close(); }
    }
  });

  it.each([false, true])("keeps issue re-dispatch styling (grouped: %s)", async grouped => {
    const entries = [{ ...job, dispatchNumber: grouped ? 4 : 3 }];
    if (grouped) entries.push({ ...job, id: 395, phase: "planning", dispatchNumber: 3 });
    const { dom, document } = await setup(entries);
    try {
      const row = document.querySelector("#log-body tr")!;
      expect(row.classList.contains("redispatch-row")).toBe(true);
      expect(row.children[1].querySelector('[title="Re-dispatch"]')?.textContent).toBe("3");
      expect(row.children[1].innerHTML).toContain("var(--st-warn-fg)");
    } finally { dom.window.close(); }
  });
});
