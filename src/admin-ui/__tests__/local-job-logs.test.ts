import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { localJobLogsHtml, localJobLogsScript } from "../local-job-logs.js";

function setup() {
  const dom = new JSDOM(localJobLogsHtml, { url: "http://localhost:8080/admin", runScripts: "outside-only" });
  const { window } = dom;
  const dialog = window.document.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event("close")); };
  const api = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ logs: "<script>bad()</script>\nreview passed", source: "live" }) });
  window.api = api;
  window.eval(localJobLogsScript);
  const el = (id: string) => window.document.getElementById("local-job-logs-" + id)!;
  return { dom, window, dialog, api, el };
}

describe("local job logs viewer", () => {
  it("shows logs safely and refreshes from the same recorded job", async () => {
    const { dom, window, api, el } = setup();
    await window.openLocalJobLogs(394, "SAN2-001");
    expect(api).toHaveBeenCalledWith("/api/jobs/394/logs");
    expect(el("output").textContent).toContain("<script>bad()</script>");
    expect(el("output").querySelector("script")).toBeNull();
    api.mockResolvedValue({ ok: true, json: async () => ({ logs: "finished", source: "saved" }) });
    el("refresh").click();
    await vi.waitFor(() => expect(el("output").textContent).toBe("finished"));
    expect(el("status").textContent).toContain("Saved recent output");
    dom.window.close();
  });

  it("explains unavailable historical logs and allows retry", async () => {
    const { dom, window, api, el } = setup();
    api.mockResolvedValue({ ok: false, status: 404 });
    await window.openLocalJobLogs(1, "SAN2-001");
    expect(el("error").hidden).toBe(false);
    expect(el("error").textContent).toContain("Older containers may have been removed");
    expect(el("output").hidden).toBe(true);
    expect(el("refresh").hasAttribute("disabled")).toBe(false);
    dom.window.close();
  });

  it("does not let an earlier job response replace the current job's logs", async () => {
    const { dom, window, api, el } = setup();
    let finish!: (value: unknown) => void;
    api.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = window.openLocalJobLogs(1, "FIRST-1");
    await window.openLocalJobLogs(2, "SECOND-2");
    finish({ ok: true, json: async () => ({ logs: "old job", source: "saved" }) });
    await first;
    expect(el("title").textContent).toContain("SECOND-2");
    expect(el("output").textContent).not.toBe("old job");
    dom.window.close();
  });
});
