import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { filesystemIssueHtml, filesystemIssueScript } from "../filesystem-issue.js";

const issueId = "filesystem:SAN2:SAN2-001";
const detail = {
  issue: { identifier: "SAN2-001", title: "Make the jellyfish pulse less" },
  markdown: "---\ntitle: Make the jellyfish pulse less\n---\n\n<img src=x onerror=alert(1)>\nReduce the pulse.",
  state: { version: 1, status: "plan-approved", comments: [{ body: "## Plan\nAdjust duration" }], updatedAt: "2026-09-14T21:00:00Z" },
  statePath: ".state/SAN2/SAN2-001.json",
};

function setup(query = "") {
  const dom = new JSDOM(filesystemIssueHtml + '<a id="issue-link" target="_blank" href="/admin?filesystemIssue=' + encodeURIComponent(issueId) + '"><span>Issue</span></a>', {
    url: "http://localhost:8080/admin" + query,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const dialog = window.document.querySelector("dialog")!;
  // jsdom does not implement native dialog behavior.
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event("close")); };
  const api = vi.fn().mockResolvedValue({ ok: true, json: async () => detail });
  window.api = api;
  window.eval(filesystemIssueScript);
  const el = (id: string) => window.document.getElementById("filesystem-issue-" + id)!;
  return { dom, window, dialog, api, el };
}

describe("filesystem issue viewer", () => {
  it("opens a clicked issue link and shows the exact Markdown and state as safe text", async () => {
    const { dom, window, dialog, api, el } = setup();
    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    window.document.querySelector("#issue-link span")!.dispatchEvent(click);
    await vi.waitFor(() => expect(el("title").textContent).toBe(detail.issue.title));
    expect(click.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/filesystem-issue?issueId=" + encodeURIComponent(issueId));
    expect(el("markdown").textContent).toBe(detail.markdown);
    expect(el("markdown").querySelector("img")).toBeNull();
    el("state-tab").click();
    expect(el("ticket-panel").hidden).toBe(true);
    expect(el("state-panel").hidden).toBe(false);
    expect(JSON.parse(el("json").textContent!)).toEqual(detail.state);
    expect(el("state-path").textContent).toBe(detail.statePath);
    el("close").click();
    expect(dialog.open).toBe(false);
    dom.window.close();
  });

  it("loads direct links only when authentication releases routing, including tickets without saved state", async () => {
    const { dom, window, dialog, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValue({ ok: true, json: async () => ({ ...detail, state: null }) });
    expect(api).not.toHaveBeenCalled();
    await window.openFilesystemIssueFromLocation();
    expect(dialog.open).toBe(true);
    el("state-tab").click();
    expect(el("json").textContent).toContain("No state file yet");
    dom.window.close();
  });

  it("refreshes saved state without changing the selected panel and clears stale content on failure", async () => {
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    await window.openFilesystemIssueFromLocation();
    el("state-tab").click();
    api.mockResolvedValue({ ok: true, json: async () => ({ ...detail, state: { ...detail.state, status: "completed" } }) });
    el("refresh").click();
    await vi.waitFor(() => expect(el("json").textContent).toContain('"completed"'));
    expect(el("state-panel").hidden).toBe(false);
    api.mockResolvedValue({ ok: false, status: 404 });
    el("refresh").click();
    await vi.waitFor(() => expect(el("error").hidden).toBe(false));
    expect(el("error").textContent).toContain("unavailable");
    expect(el("state-panel").hidden).toBe(true);
    dom.window.close();
  });

  it("ignores a late response after the viewer closes", async () => {
    const { dom, window, dialog, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    let finish!: (value: unknown) => void;
    api.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = window.openFilesystemIssueFromLocation();
    dialog.close();
    finish({ ok: true, json: async () => detail });
    await pending;
    expect(dialog.open).toBe(false);
    expect(el("title").textContent).toBe("Filesystem issue");
    dom.window.close();
  });

  it("leaves modified clicks and external tracker links to the browser", () => {
    const { dom, window, api } = setup();
    const anchor = window.document.getElementById("issue-link")!;
    const modified = new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    anchor.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    anchor.setAttribute("href", "https://linear.app/example/issue/TEST-1");
    const external = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(external);
    expect(external.defaultPrevented).toBe(false);
    expect(api).not.toHaveBeenCalled();
    dom.window.close();
  });
});
