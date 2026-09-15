import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { filesystemIssueHtml, filesystemIssueScript } from "../filesystem-issue.js";

const issueId = "filesystem:SAN2:SAN2-001";
const detail = {
  issue: { identifier: "SAN2-001", title: "Make the jellyfish pulse less" },
  markdown: "---\ntitle: Make the jellyfish pulse less\n---\n\n<img src=x onerror=alert(1)>\nReduce the pulse.",
  state: { version: 1, status: "plan-approved", comments: [{ body: "## Plan\nAdjust duration" }], updatedAt: "2026-09-14T21:00:00Z" },
  statePath: ".state/SAN2/SAN2-001.json",
  ticketPath: "active/SAN2/SAN2-001.md",
  location: "active",
  retryEligible: false,
};
const failedDetail = {
  ...detail,
  state: { ...detail.state, status: "failed", updatedAt: "2026-09-14T22:00:00Z" },
  ticketPath: "failed/SAN2/SAN2-001.md",
  location: "failed",
  retryEligible: true,
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
    expect(el("location").textContent).toBe("active/SAN2/SAN2-001.md · Active queue");
    expect((el("retry") as HTMLButtonElement).hidden).toBe(true);
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

  it("enables retry only for eligible failed issues and posts the active issue before refreshing", async () => {
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValueOnce({ ok: true, json: async () => failedDetail });
    await window.openFilesystemIssueFromLocation();
    const retry = el("retry") as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.hidden).toBe(false));
    expect(retry.disabled).toBe(false);
    expect(el("location").textContent).toBe("failed/SAN2/SAN2-001.md · Failed archive");
    api
      .mockResolvedValueOnce({ ok: true, json: async () => ({ retried: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...failedDetail, retryEligible: false, retryBlockedReason: "Retry was already queued" }) });
    retry.click();
    expect(retry.disabled).toBe(true);
    await vi.waitFor(() => expect(el("status").textContent).toBe("Queued for retry"));
    expect(api).toHaveBeenNthCalledWith(2, "/api/filesystem-issue/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });
    expect(api).toHaveBeenNthCalledWith(3, "/api/filesystem-issue?issueId=" + encodeURIComponent(issueId));
    dom.window.close();
  });

  it("keeps retry disabled with the server-provided blocked reason", async () => {
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValue({ ok: true, json: async () => ({ ...failedDetail, retryEligible: false, retryBlockedReason: "Archived ticket is missing its provider mapping" }) });
    await window.openFilesystemIssueFromLocation();
    const retry = el("retry") as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.hidden).toBe(false));
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe("Archived ticket is missing its provider mapping");
    expect(el("retry-reason").hidden).toBe(false);
    expect(el("retry-reason").textContent).toBe("Archived ticket is missing its provider mapping");
    retry.click();
    expect(api).toHaveBeenCalledTimes(1);
    dom.window.close();
  });

  it("shows retry API errors and re-enables an eligible retry", async () => {
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValueOnce({ ok: true, json: async () => failedDetail });
    await window.openFilesystemIssueFromLocation();
    const retry = el("retry") as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    api.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "Provider state changed; refresh before retrying" }) });
    retry.click();
    await vi.waitFor(() => expect(el("error").hidden).toBe(false));
    expect(el("error").textContent).toBe("Provider state changed; refresh before retrying");
    expect(retry.disabled).toBe(false);
    expect(el("status").textContent).toContain("Status: failed");
    dom.window.close();
  });

  it("prevents double-click retry submissions while a retry is in flight", async () => {
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValueOnce({ ok: true, json: async () => failedDetail });
    await window.openFilesystemIssueFromLocation();
    const retry = el("retry") as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    let finishRetry!: (value: unknown) => void;
    api.mockReturnValueOnce(new Promise(resolve => { finishRetry = resolve; }));
    retry.click();
    retry.click();
    expect(api).toHaveBeenCalledTimes(2);
    api.mockResolvedValueOnce({ ok: true, json: async () => ({ ...failedDetail, retryEligible: false }) });
    finishRetry({ ok: true, json: async () => ({ retried: true }) });
    await vi.waitFor(() => expect(el("status").textContent).toBe("Queued for retry"));
    expect(api).toHaveBeenCalledTimes(3);
    dom.window.close();
  });

  it("ignores retry responses after switching to another ticket", async () => {
    const otherIssue = "filesystem:SAN2:SAN2-002";
    const { dom, window, api, el } = setup("?filesystemIssue=" + encodeURIComponent(issueId));
    api.mockResolvedValueOnce({ ok: true, json: async () => failedDetail });
    await window.openFilesystemIssueFromLocation();
    const retry = el("retry") as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    let finishRetry!: (value: unknown) => void;
    api.mockReturnValueOnce(new Promise(resolve => { finishRetry = resolve; }));
    retry.click();
    api.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...detail,
        issue: { identifier: "SAN2-002", title: "Second filesystem ticket" },
        ticketPath: "active/SAN2/SAN2-002.md",
      }),
    });
    window.document.querySelector("#issue-link")!.setAttribute("href", "/admin?filesystemIssue=" + encodeURIComponent(otherIssue));
    window.document.querySelector("#issue-link")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => expect(el("title").textContent).toBe("Second filesystem ticket"));
    finishRetry({ ok: true, json: async () => ({ retried: true }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(el("title").textContent).toBe("Second filesystem ticket");
    expect(el("status").textContent).toContain("Status: plan-approved");
    expect(api).toHaveBeenCalledTimes(3);
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
