import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../pages/projects.js";
import type { RepoMapping } from "../../config.js";
import { makeMapping } from "../../__tests__/helpers/builders.js";

type Mapping = Record<string, unknown>;

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

function mountProjects(mapping: RepoMapping = makeMapping()): {
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
    const { win, doc, posts } = mountProjects(makeMapping({ reviewers: null }));
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
    const { win, doc, posts } = mountProjects(makeMapping({ reviewers: [] }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    const rows = reviewerRows(doc);
    expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual(["gap-analysis", "code-review"]);
    expect(rows.map((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)).toEqual([false, false]);

    await save(win);
    expect(posts[0]).toMatchObject({ reviewers: [] });
  });

  it("can turn one reviewer off and let another run without gating", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewers: null }));
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
    const { win, doc, posts } = mountProjects(makeMapping({
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
    const { win, doc, posts } = mountProjects(makeMapping({ reviewers: null }));
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
    const { win, doc, posts } = mountProjects(makeMapping({ reviewers: null }));
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
    const { win, doc, posts } = mountProjects(makeMapping({
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

describe("projects page PR dispatch budget field", () => {
  it("declares the field right after Max Iterations with matching attributes", () => {
    const maxIterAt = projectsHtml.indexOf('id="md-max-iter"');
    const budgetAt = projectsHtml.indexOf('id="md-pr-budget"');
    expect(maxIterAt).toBeGreaterThan(-1);
    expect(budgetAt).toBeGreaterThan(maxIterAt);
    expect(projectsHtml).toContain('id="md-pr-budget" type="number" min="1" step="1" placeholder="4"');
    expect(projectsHtml).toContain("Gap-fill runs per PR in 24 hours. At the limit, the PR is parked for a human.");
  });

  it("loads the stored budget, and leaves it blank when null", async () => {
    const { win, doc } = mountProjects(makeMapping({ prDispatchBudget: 6 }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    expect((doc.getElementById("md-pr-budget") as HTMLInputElement).value).toBe("6");

    const { win: win2, doc: doc2 } = mountProjects(makeMapping({ prDispatchBudget: null }));
    await win2.loadMappings();
    win2.openMappingDialog("AII");
    expect((doc2.getElementById("md-pr-budget") as HTMLInputElement).value).toBe("");
  });

  it("saves a changed value as a number and a blank as null", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ prDispatchBudget: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-pr-budget") as HTMLInputElement).value = "8";
    await save(win);
    expect(posts[0]).toMatchObject({ prDispatchBudget: 8 });

    win.openMappingDialog("AII");
    (doc.getElementById("md-pr-budget") as HTMLInputElement).value = "";
    await save(win);
    expect(posts[1]).toMatchObject({ prDispatchBudget: null });
  });

  it("validates the field like the other caps, via CAP_FIELDS", async () => {
    expect(projectsScript).toContain("['PR Dispatch Budget', 'prDispatchBudget']");

    const { win, doc, posts } = mountProjects(makeMapping({ prDispatchBudget: null }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-pr-budget") as HTMLInputElement).value = "1.5";
    await save(win);
    expect(posts).toEqual([]);
    expect(doc.getElementById("md-error")?.textContent).toContain("PR Dispatch Budget must be a positive integer, or blank for the default.");
  });
});

describe("projects page review-fix lifecycle field", () => {
  it("declares the Legacy/Restate select in the Execution panel with owner-retention copy", () => {
    expect(projectsHtml).toContain('id="md-review-fix-lifecycle"');
    expect(projectsHtml).toContain('<option value="legacy">Legacy</option>');
    expect(projectsHtml).toContain('<option value="restate">Restate (pilot)</option>');
    expect(projectsHtml).toContain("an attempt already dispatched keeps the lifecycle that dispatched it");
    expect(projectsHtml).toContain("does not cancel or migrate anything already in flight");
  });

  it("defaults a new mapping's visual selection to Legacy when no lifecycle is stored", async () => {
    const { win, doc } = mountProjects(makeMapping());
    await win.loadMappings();
    win.openMappingDialog("AII");

    expect((doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value).toBe("legacy");
  });

  it("loads an existing Restate selection as-is regardless of the default", async () => {
    const { win, doc } = mountProjects(makeMapping({ reviewFixLifecycle: "restate" }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    expect((doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value).toBe("restate");
  });

  it("round-trips a changed selection through save and reload", async () => {
    const mapping = makeMapping({ reviewFixLifecycle: "legacy" });
    const { win, doc, posts } = mountProjects(mapping);
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value = "restate";
    await save(win);
    expect(posts[0]).toMatchObject({ reviewFixLifecycle: "restate" });
    expect(posts).toHaveLength(1);

    // Simulate the persisted store reflecting the save (the mock GET otherwise stays static).
    mapping.reviewFixLifecycle = "restate";
    win.openMappingDialog("AII");
    expect((doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value).toBe("restate");
  });

  it("leaves a rejected enable visibly unsaved with the backend's cause, and issues no other call", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewFixLifecycle: "legacy" }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value = "restate";

    const calls: Array<{ url: string; method?: string }> = [];
    const origApi = win.api;
    win.api = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method });
      if (url === "/api/mappings" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'reviewFixLifecycle "restate" requires a registered, healthy Restate endpoint, which is not currently available',
          }),
        };
      }
      return origApi(url, init);
    };

    await save(win);

    expect(posts).toEqual([]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const dialog = doc.getElementById("mapping-dialog") as unknown as { open: boolean };
    expect(dialog.open).toBe(true);
    const errEl = doc.getElementById("md-error");
    expect(errEl?.classList.contains("hidden")).toBe(false);
    expect(errEl?.textContent).toContain("registered, healthy Restate endpoint");
    // The attempted (not reverted) value stays visible.
    expect((doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value).toBe("restate");
  });

  it("recovers from a rejected save request (network failure) without leaving the button stuck", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewFixLifecycle: "legacy" }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value = "restate";
    (doc.getElementById("md-branch") as HTMLInputElement).value = "development";

    const calls: Array<{ url: string; method?: string }> = [];
    const origApi = win.api;
    win.api = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method });
      if (url === "/api/mappings" && init?.method === "POST") {
        return Promise.reject(new Error("network error"));
      }
      return origApi(url, init);
    };

    const saveBtn = doc.getElementById("md-save") as HTMLButtonElement;
    await expect(save(win)).resolves.toBeUndefined();

    expect(posts).toEqual([]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe("Save Mapping");

    const dialog = doc.getElementById("mapping-dialog") as unknown as { open: boolean };
    expect(dialog.open).toBe(true);
    expect((doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value).toBe("restate");
    expect((doc.getElementById("md-branch") as HTMLInputElement).value).toBe("development");

    const errEl = doc.getElementById("md-error");
    expect(errEl?.classList.contains("hidden")).toBe(false);
    expect(errEl?.textContent).toBeTruthy();
    expect(errEl?.textContent).not.toMatch(/^Server error:/);
    // A rejected request doesn't prove the save didn't apply server-side, so the
    // message must not claim certainty that nothing was saved.
    expect(errEl?.textContent).not.toMatch(/was not saved/i);
    expect(errEl?.textContent).toMatch(/could not confirm the save/i);
    expect(errEl?.textContent).toMatch(/reload/i);
  });

  it("renders a distinct cause for an unsupported execution mode vs. an unavailable registration", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewFixLifecycle: "legacy", executionMode: "fly-machines" }));
    await win.loadMappings();
    win.openMappingDialog("AII");

    (doc.getElementById("md-review-fix-lifecycle") as HTMLSelectElement).value = "restate";

    const origApi = win.api;
    win.api = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/mappings" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'reviewFixLifecycle "restate" requires executionMode "github-actions"' }),
        };
      }
      return origApi(url, init);
    };

    await save(win);

    expect(posts).toEqual([]);
    const unsupportedExecutionMessage = doc.getElementById("md-error")?.textContent;
    expect(unsupportedExecutionMessage).toContain('requires executionMode "github-actions"');
    expect(unsupportedExecutionMessage).not.toContain("registered, healthy Restate endpoint");
  });
});

describe("projects page review process and trusted review authors", () => {
  it("declares both controls with the exact hints", () => {
    expect(projectsHtml).toContain('id="md-review-process"');
    expect(projectsHtml).toContain('<option value="ai-implement">AI-Implement</option>');
    expect(projectsHtml).toContain('<option value="claude-code-review">Claude Code Review</option>');
    expect(projectsHtml).toContain('<option value="claude-code-review-repository-fix">Claude Code Review, repository auto-fix</option>');
    expect(projectsHtml).toContain("Who reviews this project's PRs and who fixes. Claude Code Review trusts claude[bot], reads the verdict from the review check run and Claude's inline comments, and keeps AI-Implement's fix attempt. Claude Code Review, repository auto-fix reads the same way but leaves Claude's findings to the repository's own auto-fix, and approves only when the auto-fix commit's review is clean. Applies to every project; only the forward to the Restate fix attempt needs the Restate lifecycle.");
    expect(projectsHtml).toContain('id="md-trusted-review-authors"');
    expect(projectsHtml).toContain("Extra bot or user logins whose review findings count, in addition to the review process's own authors. A trusted author can approve a PR.");
  });

  it("loads stored values, defaulting when null", async () => {
    const { win, doc } = mountProjects(makeMapping({ reviewProcess: "claude-code-review", trustedReviewAuthors: ["a[bot]", "b"] }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    expect((doc.getElementById("md-review-process") as HTMLSelectElement).value).toBe("claude-code-review");
    expect((doc.getElementById("md-trusted-review-authors") as HTMLTextAreaElement).value).toBe("a[bot]\nb");

    const { win: win2, doc: doc2 } = mountProjects(makeMapping({ reviewProcess: null, trustedReviewAuthors: null }));
    await win2.loadMappings();
    win2.openMappingDialog("AII");
    expect((doc2.getElementById("md-review-process") as HTMLSelectElement).value).toBe("ai-implement");
    expect((doc2.getElementById("md-trusted-review-authors") as HTMLTextAreaElement).value).toBe("");
  });

  it("saves the select value and a cleaned author array, or null when blank", async () => {
    const { win, doc, posts } = mountProjects(makeMapping());
    await win.loadMappings();
    win.openMappingDialog("AII");
    (doc.getElementById("md-review-process") as HTMLSelectElement).value = "claude-code-review";
    (doc.getElementById("md-trusted-review-authors") as HTMLTextAreaElement).value = " x \n\n y ";
    await save(win);
    expect(posts[0]).toMatchObject({ reviewProcess: "claude-code-review", trustedReviewAuthors: ["x", "y"] });

    win.openMappingDialog("AII");
    (doc.getElementById("md-trusted-review-authors") as HTMLTextAreaElement).value = "  \n ";
    await save(win);
    expect(posts[1]).toMatchObject({ trustedReviewAuthors: null });
  });

  it.each(["reviewProcess invalid: nope", "trustedReviewAuthors invalid: bad login"])("shows the API error %s", async (error) => {
    const { win, doc } = mountProjects(makeMapping());
    await win.loadMappings();
    win.openMappingDialog("AII");
    win.api = async () => ({ ok: false, status: 400, json: async () => ({ error }) });
    await save(win);
    expect(doc.getElementById("md-error")?.textContent).toContain(error);
  });
});

describe("projects page agents tab", () => {
  const defaults = {
    configured: true,
    mode: "configured",
    stages: Object.fromEntries(
      ["planning", "implementation", "review"].map((stage) => [
        stage,
        { agent: "codex", provider: "openai", model: "gpt-default", accountProfileId: "acct-1", invocationTimeoutMs: 600000 },
      ]),
    ),
  };
  const account = (overrides: Mapping = {}): Mapping => ({
    profileId: "acct-1",
    identity: "Team key",
    revision: 1,
    agent: "codex",
    provider: "openai",
    authMode: "openai-api-key",
    allowedProjectKeys: ["AII"],
    profileStatus: "active",
    account: { readiness: "ready", failureCode: null },
    ...overrides,
  });

  function mountAgents(opts: { stored?: Mapping; accounts?: Mapping[]; put?: { status: number; body: Mapping } } = {}) {
    const m = mountProjects(makeMapping({ executionMode: "fly-machines" }));
    const calls: { url: string; method: string; body: unknown }[] = [];
    const base = m.win.api;
    m.win.api = async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/api/mappings/AII/agent-config" && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ projectKey: "AII", enabled: false, mode: "legacy", stages: {}, ...opts.stored }) };
      }
      if (url === "/api/agent-defaults") return { ok: true, status: 200, json: async () => defaults };
      if (url === "/api/model-accounts") return { ok: true, status: 200, json: async () => ({ accounts: opts.accounts ?? [account()] }) };
      if (url === "/api/mappings/AII/agent-config" && method === "PUT") {
        const r = opts.put ?? { status: 200, body: { enabled: true, stages: {} } };
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      }
      return base(url, init);
    };
    return { ...m, calls };
  }

  async function open(m: ReturnType<typeof mountAgents>) {
    await m.win.loadMappings();
    m.win.openMappingDialog("AII");
    await m.win.agentConfigLoaded();
  }

  function fire(doc: Document, el: Element) {
    el.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true }));
  }
  const field = (doc: Document, kind: "mode" | "value", stage: string, f: string) =>
    doc.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-ag-${kind}][data-stage="${stage}"][data-field="${f}"]`)!;
  const preview = (doc: Document, stage: string, f: string) => doc.querySelector(`[data-ag-preview="${stage}.${f}"]`)!.textContent;
  const puts = (m: ReturnType<typeof mountAgents>) => m.calls.filter((c) => c.method === "PUT");

  it("previews the override and restores the inherited value on clear, sending only changed fields", async () => {
    const m = mountAgents();
    await open(m);
    expect(preview(m.doc, "review", "model")).toContain("gpt-default (source: orchestrator default)");

    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
    const input = field(m.doc, "value", "review", "model");
    input.value = "gpt-custom";
    input.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    expect(preview(m.doc, "review", "model")).toContain("gpt-custom (source: project)");
    expect(puts(m)).toHaveLength(0);

    await m.win.saveAgentConfig();
    expect(puts(m)).toHaveLength(1);
    expect(puts(m)[0]).toMatchObject({ url: "/api/mappings/AII/agent-config", body: { stages: { review: { model: "gpt-custom" } } } });
    expect(m.calls.some((c) => c.url === "/api/agent-defaults" && c.method !== "GET")).toBe(false);
  });

  it("does not show claude/anthropic in disabled inherited agent and provider controls", async () => {
    const m = mountAgents();
    await open(m);
    const agent = field(m.doc, "value", "review", "agent");
    const provider = field(m.doc, "value", "review", "provider");
    expect(agent.disabled).toBe(true);
    expect(agent.value).toBe("codex");
    expect(provider.value).toBe("openai");

    const mode = field(m.doc, "mode", "review", "agent");
    mode.value = "override";
    fire(m.doc, mode);
    const seeded = field(m.doc, "value", "review", "agent");
    expect(seeded.disabled).toBe(false);
    expect(seeded.value).toBe("codex");
    await m.win.saveAgentConfig();
    const body = puts(m)[0]?.body as { stages?: Record<string, Record<string, unknown>> } | undefined;
    expect(body?.stages?.review?.provider).toBeUndefined();
    expect(body?.stages?.review?.agent ?? "codex").toBe("codex");
  });

  it("sends null when an override is cleared and shows the inherited value", async () => {
    const m = mountAgents({ stored: { enabled: true, mode: "configured", stages: { review: { model: "gpt-custom" } } } });
    await open(m);
    expect(preview(m.doc, "review", "model")).toContain("(source: project)");
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "inherit";
    fire(m.doc, mode);
    expect(preview(m.doc, "review", "model")).toContain("gpt-default (source: orchestrator default)");
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ stages: { review: { model: null } } });
  });

  it("blocks the PUT when an override is left blank or the timeout is not a positive integer", async () => {
    const m = mountAgents();
    await open(m);
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
    const blank = field(m.doc, "value", "review", "model");
    blank.value = "   ";
    blank.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    await m.win.saveAgentConfig();
    expect(puts(m)).toHaveLength(0);
    expect(m.doc.getElementById("md-agents-error")!.textContent).toContain("Model is blank");

    const mode2 = field(m.doc, "mode", "review", "model");
    mode2.value = "inherit";
    fire(m.doc, mode2);
    const tmode = field(m.doc, "mode", "review", "invocationTimeoutMs");
    tmode.value = "override";
    fire(m.doc, tmode);
    const tin = field(m.doc, "value", "review", "invocationTimeoutMs");
    tin.value = "";
    tin.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    await m.win.saveAgentConfig();
    expect(puts(m)).toHaveLength(0);
    expect(m.doc.getElementById("md-agents-error")!.textContent).toContain("positive whole number");
  });

  it("lists only active, permitted, compatible profiles and shows readiness and recovery", async () => {
    const m = mountAgents({
      accounts: [
        account(),
        account({ profileId: "acct-off", profileStatus: "disabled" }),
        account({ profileId: "acct-other", allowedProjectKeys: ["OTHER"] }),
        account({ profileId: "acct-claude", agent: "claude", provider: "anthropic", authMode: "claude-subscription", account: { readiness: "sign-in required", failureCode: "authentication_required", sessionRecovery: { state: "recovery_required", recoveryRequired: true } } }),
        account({ profileId: "acct-bad", identity: "<img src=x onerror=alert(1)>", account: { readiness: "missing", failureCode: "x" } }),
      ],
    });
    await open(m);
    const mode = field(m.doc, "mode", "planning", "accountProfileId");
    mode.value = "override";
    fire(m.doc, mode);
    const options = Array.from(field(m.doc, "value", "planning", "accountProfileId").querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(["", "acct-1", "acct-bad"]);
    const panel = m.doc.querySelector('[data-md-panel="agents"]')!;
    expect(panel.querySelector("img")).toBeNull();
    const text = panel.textContent!;
    expect(text).toContain("readiness: sign-in required (authentication_required)");
    expect(text).toContain("session recovery: recovery_required, recovery required");
    expect(text).toContain("readiness: missing (x)");
  });

  it("blocks opt-in when a stage profile is not eligible", async () => {
    const m = mountAgents({ accounts: [account({ allowedProjectKeys: ["OTHER"] })] });
    await open(m);
    const box = m.doc.getElementById("md-agents-enabled") as HTMLInputElement;
    box.checked = true;
    fire(m.doc, box);
    await m.win.saveAgentConfig();
    expect(puts(m)).toHaveLength(0);
    expect(box.checked).toBe(false);
    expect(m.doc.getElementById("md-agents-error")!.textContent).toContain("Cannot enable");
  });

  it.each([
    [422, "claude_subscription_unsupported", "Claude subscription"],
    [409, "unsupported_backend", "GitHub Actions"],
    [409, "readiness_unavailable", "Readiness could not be checked"],
    [503, "readiness_unavailable", "Readiness could not be checked"],
    [409, "stale_inputs", "refreshed"],
    [422, "resolution_failed", "do not resolve"],
  ])("leaves the opt-in unchecked and shows fixed copy for %i %s", async (status, code, copy) => {
    const m = mountAgents({ put: { status, body: { error: "<b>raw</b> secret-ish", code } } });
    await open(m);
    const box = m.doc.getElementById("md-agents-enabled") as HTMLInputElement;
    box.checked = true;
    fire(m.doc, box);
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ enabled: true });
    expect(box.checked).toBe(false);
    const err = m.doc.getElementById("md-agents-error")!;
    expect(err.textContent).toContain(copy);
    expect(err.textContent).not.toContain("raw");
  });

  it("shows the action string for GitHub Actions template codes", async () => {
    const m = mountAgents({ put: { status: 409, body: { code: "runner_incompatible", action: "Run the existing workflow sync." } } });
    await open(m);
    const box = m.doc.getElementById("md-agents-enabled") as HTMLInputElement;
    box.checked = true;
    fire(m.doc, box);
    await m.win.saveAgentConfig();
    expect(m.doc.getElementById("md-agents-error")!.textContent).toContain("Run the existing workflow sync.");
  });

  it("has no credential input, issue override, and states scope copy", async () => {
    const m = mountAgents();
    await open(m);
    const panel = m.doc.querySelector('[data-md-panel="agents"]')!;
    expect(panel.querySelector('input[type="password"]')).toBeNull();
    expect(panel.textContent).not.toMatch(/token|api key|secret/i);
    expect(panel.textContent).toContain("apply to the next run");
    expect(panel.textContent).toContain("Prompts and review rules stay in the repository");
    expect(panel.textContent).toContain("no per-issue override");
  });

  it("disables the Agents tab for a new mapping and issues no agent requests", async () => {
    const m = mountAgents();
    await m.win.loadMappings();
    m.win.openMappingDialog();
    expect((m.doc.getElementById("md-tab-agents") as HTMLButtonElement).disabled).toBe(true);
    expect(m.calls.some((c) => c.url.includes("agent-config"))).toBe(false);
  });

  it("leaves the mapping save payload free of agent fields", async () => {
    const m = mountAgents();
    await open(m);
    await save(m.win);
    expect(JSON.stringify(m.posts[0])).not.toMatch(/agent|stages/i);
    expect(puts(m)).toHaveLength(0);
  });
});
