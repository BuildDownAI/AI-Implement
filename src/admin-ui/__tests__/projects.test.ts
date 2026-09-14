import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../pages/projects.js";

type Mapping = Record<string, unknown>;

const baseMapping = (overrides: Mapping = {}): Mapping => ({
  owner: "BuildDownAI",
  repo: "AI-Implement",
  workflowFile: "claude-implement.yml",
  defaultBranch: "main",
  maxInProgressAiIssues: 3,
  executionMode: "github-actions",
  sessionMode: "autonomous",
  machineCpus: 2,
  machineMemoryMb: 4096,
  planningEnabled: false,
  autoApprovePlans: true,
  autoMerge: false,
  provider: "anthropic",
  ticketingProvider: "linear",
  ticketingConfig: { kind: "linear" },
  ...overrides,
});

function escapeText(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function mountProjects(mapping: Mapping = baseMapping()): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win: any;
  doc: Document;
  posts: unknown[];
} {
  const dom = new JSDOM(`<!DOCTYPE html><body>${projectsHtml}</body>`, {
    runScripts: "dangerously",
    url: "http://localhost/admin#projects",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any;
  const posts: unknown[] = [];
  win.esc = escapeText;
  win.escAttr = escapeAttr;
  win.safeUrl = (value: unknown) => String(value == null ? "#" : value);
  win.registerPage = () => {};
  win.api = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/mappings" && init?.method === "POST") {
      posts.push(JSON.parse(init.body || "{}"));
      return { ok: true, status: 200, json: async () => ({ syncJobId: null }) };
    }
    if (url === "/api/mappings") {
      return { ok: true, status: 200, json: async () => ({ AII: mapping }) };
    }
    if (url === "/api/admin/config-status") {
      return { ok: true, status: 200, json: async () => ({ linear: true, jira: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  win.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  const script = dom.window.document.createElement("script");
  script.textContent = projectsScript;
  dom.window.document.head.appendChild(script);
  return { win, doc: dom.window.document as Document, posts };
}

async function save(win: { saveMappingDialog: () => Promise<void> }): Promise<void> {
  await win.saveMappingDialog();
}

function reviewerRows(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("#md-reviewer-list > div"));
}

describe("projects page reviewer control", () => {
  it("declares the reviewer controls and uses escAttr for reviewer attribute contexts", () => {
    expect(projectsHtml).toContain('id="md-reviewer-list"');
    expect(projectsHtml).toContain('id="md-reviewer-id"');
    expect(projectsHtml).toContain("Reviewer Max turns blank = inherit");
    expect(projectsScript).toContain('title="\' + window.escAttr(reviewer.id) + \'"');
    expect(projectsScript).toContain('aria-label="Runs \' + window.escAttr(reviewer.id) + \'"');
    expect(projectsScript).toContain('aria-label="Max turns for \' + window.escAttr(reviewer.id) + \', blank inherits reviewer default or global limit"');
    expect(projectsScript).toContain("+ window.esc(reviewer.id) +");
  });

  it("shows the built-in default for a null value and saves null when untouched", async () => {
    const { win, doc, posts } = mountProjects(baseMapping({ reviewers: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const rows = reviewerRows(doc);
    expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual(["gap-analysis", "code-review"]);
    expect(rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((input) => input.checked))).toEqual([
      true,
      true,
      true,
      true,
    ]);

    await save(win);
    expect(posts[0]).toMatchObject({ reviewers: null });
  });

  it("preserves an explicit empty reviewer list on an unrelated save", async () => {
    const { win, doc, posts } = mountProjects(baseMapping({ reviewers: [] }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const rows = reviewerRows(doc);
    expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual(["gap-analysis", "code-review"]);
    expect(rows.map((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)).toEqual([false, false]);

    await save(win);
    expect(posts[0]).toMatchObject({ reviewers: [] });
  });

  it("can turn one reviewer off and let another run without gating", async () => {
    const { win, doc, posts } = mountProjects(baseMapping({ reviewers: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const rows = reviewerRows(doc);
    const gapRuns = rows[0].querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0];
    const codeGates = rows[1].querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    gapRuns.checked = false;
    gapRuns.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));
    codeGates.checked = false;
    codeGates.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));

    await save(win);
    expect(posts[0]).toMatchObject({ reviewers: [{ id: "code-review", gates: false }] });
  });

  it("round-trips reviewer maxTurns and omits blank inherited caps", async () => {
    const { win, doc, posts } = mountProjects(baseMapping({
      reviewers: [
        { id: "gap-analysis", gates: true, maxTurns: 45 },
        { id: "code-review", gates: false },
      ],
    }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const rows = reviewerRows(doc);
    expect(rows[0].querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("45");
    expect(rows[1].querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("");
    const codeMaxTurns = rows[1].querySelector<HTMLInputElement>('input[type="number"]')!;
    codeMaxTurns.value = "60";
    codeMaxTurns.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));
    const gapMaxTurns = rows[0].querySelector<HTMLInputElement>('input[type="number"]')!;
    gapMaxTurns.value = "";
    gapMaxTurns.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));

    await save(win);
    expect(posts[0]).toMatchObject({
      reviewers: [
        { id: "gap-analysis", gates: true },
        { id: "code-review", gates: false, maxTurns: 60 },
      ],
    });
  });

  it("blocks reviewer maxTurns outside 1 through 200 before posting", async () => {
    const { win, doc, posts } = mountProjects(baseMapping({ reviewers: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const maxTurns = reviewerRows(doc)[0].querySelector<HTMLInputElement>('input[type="number"]')!;
    maxTurns.value = "201";
    maxTurns.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));

    await save(win);
    expect(posts).toEqual([]);
    expect(doc.getElementById("md-error")?.textContent).toContain("Max turns");
  });

  it("adds custom reviewer ids and escapes them as text rather than markup", async () => {
    const dangerousId = 'repo-review"><script>alert(1)</script>';
    const { win, doc, posts } = mountProjects(baseMapping({ reviewers: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    doc.getElementById("md-reviewer-id")!.setAttribute("value", dangerousId);
    (doc.getElementById("md-reviewer-id") as HTMLInputElement).value = dangerousId;
    win.addProjectReviewer();

    const list = doc.getElementById("md-reviewer-list")!;
    expect(list.textContent).toContain(dangerousId);
    expect(list.querySelector("script")).toBeNull();

    await save(win);
    expect(posts[0]).toMatchObject({
      reviewers: [
        { id: "gap-analysis", gates: true },
        { id: "code-review", gates: true },
        { id: dangerousId, gates: true },
      ],
    });
  });

  it("loads and preserves a stored custom selection when nothing else changes", async () => {
    const custom = 'custom "quoted" reviewer';
    const { win, doc, posts } = mountProjects(baseMapping({
      reviewers: [{ id: custom, gates: false, maxTurns: 33 }],
    }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    expect(reviewerRows(doc).map((row) => row.querySelector(".mono")?.textContent)).toEqual([
      "gap-analysis",
      "code-review",
      custom,
    ]);

    await save(win);
    expect(posts[0]).toMatchObject({ reviewers: [{ id: custom, gates: false, maxTurns: 33 }] });
  });
});
