import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { pipelinesHtml, pipelinesScript } from "../pages/pipelines.js";
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
