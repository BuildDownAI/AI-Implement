import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { pipelinesHtml, pipelinesScript } from "../pages/pipelines.js";
import { kgPipelinesHtml } from "../pages/kg-pipelines.js";
import { localJobLogsHtml, localJobLogsScript } from "../local-job-logs.js";

const job = {
  id: 396, issueId: "filesystem:SAN2:SAN2-002", issueIdentifier: "SAN2-002",
  phase: "implementation", dispatchNumber: 1, executionMode: "local-docker",
  runnerMode: "local", machineId: "a".repeat(64), status: "running", dispatchedAt: Date.now(),
};

async function setup(entries = [job], logsStatus = 200) {
  const dom = new JSDOM(pipelinesHtml + localJobLogsHtml, { runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const api = vi.fn(async (url: string) => ({
    ok: url.startsWith("/api/log?") || logsStatus === 200,
    status: url.startsWith("/api/log?") ? 200 : logsStatus,
    json: async () => url.startsWith("/api/log?") ? entries : { logs: "saved runner output", source: "saved" },
  }));
  window.api = api;
  window.esc = window.escAttr = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
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
