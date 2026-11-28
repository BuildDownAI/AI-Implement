import { describe, expect, it, vi } from "vitest";
import { projectsHtml, projectsScript } from "../pages/projects.js";
import { componentsCss } from "../components.js";
import type { RepoMapping } from "../../config.js";
import { makeMapping } from "../../__tests__/helpers/builders.js";
import { mountAdminPage } from "../../__tests__/helpers/fixtures/admin-ui.js";

type Mapping = Record<string, unknown>;

/** `refused` answers the save, or the load, with a refusal instead of success. */
function mountProjects(mapping: RepoMapping = makeMapping(), refused: { save?: { status: number; body: unknown }; load?: { status: number; body: unknown } } = {}) {
  const posts: unknown[] = [];
  const mounted = mountAdminPage({
    html: projectsHtml,
    script: projectsScript,
    route: "projects",
    api: async (url, init) => {
      if (url === "/api/mappings" && init?.method === "POST") {
        posts.push(JSON.parse(init.body || "{}"));
        if (refused.save) return { ok: false, status: refused.save.status, json: async () => refused.save!.body };
        return { ok: true, status: 200, json: async () => ({ syncJobId: null }) };
      }
      if (url === "/api/mappings") {
        if (refused.load) return { ok: false, status: refused.load.status, json: async () => refused.load!.body };
        return { ok: true, status: 200, json: async () => ({ AII: mapping }) };
      }
      if (url === "/api/admin/config-status") {
        return { ok: true, status: 200, json: async () => ({ linear: true, jira: false }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    // jsdom has no dialog methods, and the page opens its edit dialog with them.
    before: (win) => {
      win.HTMLDialogElement.prototype.showModal = function showModal(this: { open: boolean }) {
        this.open = true;
      };
      win.HTMLDialogElement.prototype.close = function close(this: { open: boolean }) {
        this.open = false;
      };
    },
  });
  return { ...mounted, posts };
}

async function save(win: { saveMappingDialog: () => Promise<void> }): Promise<void> {
  await win.saveMappingDialog();
}

function reviewerRows(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("#md-reviewer-list > div"));
}

describe("the Edit dialog's save refused by the server", () => {
  const activeTab = (doc: Document) => (doc.querySelector("#md-tabs [data-md-tab].active") as HTMLElement).dataset.mdTab;
  const shownError = (doc: Document) => doc.getElementById("md-error")!.textContent;

  // The tab comes from where the markup puts the setting, a nested ticketing key by its own label.
  it.each([
    ["maxTurns", "capacity"],
    ["sensitiveAddPatterns", "guardrails"],
    ["ticketingConfig.jql", "ticketing"],
    ["machineCpuKind", "execution"],
  ])("opens the tab holding %s, %s, and shows the server's sentence as it is", async (field, tab) => {
    const error = "The setting was refused.";
    const { win, doc } = mountProjects(makeMapping(), { save: { status: 400, body: { error, field } } });
    await win.loadMappings();
    win.openMappingDialog("AII");
    win.switchMappingTab("source");
    await save(win);
    expect([activeTab(doc), shownError(doc)]).toEqual([tab, error]);
  });

  it("stays on the open tab for a refusal that names no setting", async () => {
    const { win, doc } = mountProjects(makeMapping(), { save: { status: 400, body: { error: "Invalid request body" } } });
    await win.loadMappings();
    win.openMappingDialog("AII");
    win.switchMappingTab("source");
    await save(win);
    expect([activeTab(doc), shownError(doc)]).toEqual(["source", "Invalid request body"]);
  });
});

describe("the Projects table's load refused", () => {
  it("shows the refusal instead of rendering its body as projects", async () => {
    const { win, doc } = mountProjects(makeMapping(), { load: { status: 503, body: { error: "Access control is unavailable" } } });
    await win.loadMappings();
    expect(doc.querySelectorAll("#mappings-body tr")).toHaveLength(0);
    const empty = doc.getElementById("mappings-empty")!;
    expect([empty.classList.contains("hidden"), empty.textContent]).toEqual([false, "Access control is unavailable"]);
  });
});

describe("projects table containment", () => {
  it("uses a shared horizontal scroll container for the table and its Edit action", async () => {
    const tightBodyRule = /\.card-body\.tight\s*\{([^}]*)\}/.exec(componentsCss)?.[1] ?? "";
    expect(tightBodyRule).toContain("overflow-x: auto");

    const { win, doc } = mountProjects();
    await win.loadMappings();
    const table = doc.querySelector("#mappings-body")!.closest("table.tbl")!;
    expect(table.parentElement?.matches(".card > .card-body.tight")).toBe(true);
    const edit = Array.from(table.querySelectorAll("button")).find((button) => button.textContent === "Edit");
    expect(edit).toBeDefined();
    edit!.click();
    expect(doc.querySelector<HTMLDialogElement>("#mapping-dialog")!.open).toBe(true);
    expect(doc.querySelector<HTMLInputElement>("#md-team-key-orig")!.value).toBe("AII");
  });
});

describe("projects page setup columns", () => {
  const CHECKED = Date.parse("2026-11-12T10:00:00Z");

  type Row = { id: string; state: string; tier: string; project?: string; checkedAt?: number; verifiable?: false };
  type Run = { checkedAt: number; results: Row[] };
  /** A required (core) row of AII's unless the extras say otherwise. */
  const row = (id: string, state: string, extra: Partial<Row> = {}): Row => ({ id, state, tier: "core", project: "AII", ...extra });
  const feature = (id: string, state: string, extra: Partial<Row> = {}): Row => row(id, state, { tier: "feature", ...extra });

  /**
   * The page with the stored run `run`, or its read answering `status`, its clock an hour after the run.
   * The project route answers `projectRun` (null for a failure) and stores it, so the next read returns it.
   * The page lists the projects `keys`, AII alone by default.
   */
  function mountWithRun(run: Run | null, status = 200, projectRun: Run | null = null, keys = ["AII"]) {
    let stored = run;
    const calls: string[] = [];
    const alerts: string[] = [];
    const { win, doc } = mountAdminPage({
      html: projectsHtml,
      script: projectsScript,
      route: "projects",
      api: async (url, init) => {
        if (init?.method === "POST") calls.push(`${url} ${init.body}`);
        if (url === "/api/setup-checks") return { ok: status < 400, status, json: async () => ({ run: stored, progress: null, groups: {} }) };
        if (url === "/api/setup-checks/project") {
          if (!projectRun) return { ok: false, status: 503, json: async () => ({ error: "restate-unavailable" }) };
          stored = projectRun;
          return { ok: true, status: 200, json: async () => ({ run: projectRun, groups: {} }) };
        }
        if (url === "/api/mappings") return { ok: true, status: 200, json: async () => Object.fromEntries(keys.map((key) => [key, makeMapping()])) };
        return { ok: true, status: 200, json: async () => ({}) };
      },
      before: (w) => {
        w.Date.now = () => CHECKED + 60 * 60 * 1000;
        w.alert = (message: string) => alerts.push(message);
      },
    });
    const column = (name: string) => {
      const table = doc.getElementById("mappings-body")!.closest("table")!;
      const header = Array.from(table.querySelectorAll("thead th"), (th) => (th as HTMLElement).textContent);
      return doc.querySelector("#mappings-body tr")!.children[header.indexOf(name)] as HTMLElement;
    };
    const note = () => doc.getElementById("projects-setup-note") as HTMLElement;
    return { win, calls, alerts, note, required: () => column("Setup"), optional: () => column("Optional setup") };
  }

  /** The marker's badge kind and label, whether it links anywhere, and its title. */
  function marker(cell: HTMLElement) {
    const holder = cell.firstElementChild as HTMLElement;
    return { badge: holder.querySelector(".badge")?.className, label: holder.textContent, link: holder.getAttribute("href"), title: holder.title };
  }

  it("offers a project no run has checked a button that checks it, before the first run or after", async () => {
    for (const run of [null, { checkedAt: CHECKED, results: [row("github.permissions", "fail", { project: "SAN" }), row("env.poll-interval", "fail", { project: undefined })] }]) {
      const { win, required, optional } = mountWithRun(run);
      await win.loadMappings();
      expect(required().querySelector("button")!.textContent).toBe("Check setup");
      expect(optional().innerHTML).toBe("");
    }
  });

  it("runs the project's checks from that button and shows what they found", async () => {
    const { win, calls, required } = mountWithRun(null, 200, { checkedAt: CHECKED, results: [row("github.installation", "fail")] });
    await win.loadMappings();
    required().querySelector("button")!.click();
    await vi.waitFor(() => expect(required().querySelector("button")).toBeNull());
    expect(calls).toEqual(['/api/setup-checks/project {"project":"AII"}']);
    expect(marker(required()).label).toBe("Fail");
  });

  it("gives the button back, and says so, when the project's checks cannot run", async () => {
    const { win, alerts, required } = mountWithRun(null);
    await win.loadMappings();
    const button = required().querySelector("button")!;
    button.click();
    await vi.waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]).toContain("AII");
    expect(button.disabled).toBe(false);
  });

  it("reads Unavailable, not a button, while the stored run cannot be read", async () => {
    const { win, required, optional } = mountWithRun({ checkedAt: CHECKED, results: [row("github.permissions", "fail")] }, 503);
    await win.loadMappings();
    expect(required().textContent).toBe("Unavailable");
    expect(required().querySelector("button")).toBeNull();
    expect(optional().innerHTML).toBe("");
  });

  it.each([
    [["fail", "cannot-verify", "warn", "pass"], "badge fail", "Fail", 3],
    [["cannot-verify", "warn", "pass"], "badge info", "Cannot verify", 2],
    [["warn", "pass"], "badge warn", "Warning", 1],
  ])("turns the required marker to its worst row's state: %j", async (states, badge, label, toLook) => {
    const { win, required } = mountWithRun({ checkedAt: CHECKED, results: states.map((state, i) => row(`check-${i}`, state, { tier: i % 2 ? "mode" : "core" })) });
    await win.loadMappings();
    // The title's facts: how many checks to look at, and when they ran.
    const shown = marker(required());
    expect(shown).toMatchObject({ badge, label, link: null });
    expect(shown.title).toMatch(new RegExp(`^${toLook}\\b`));
    expect(shown.title).toContain("1h ago");
  });

  it("reads Pass when every required row passes, with nothing to look at", async () => {
    const { win, required } = mountWithRun({ checkedAt: CHECKED, results: [row("github.installation", "pass"), row("github.workflow-default-branch", "pass", { tier: "mode" })] });
    await win.loadMappings();
    const shown = marker(required());
    expect(shown).toMatchObject({ badge: "badge success", label: "Pass", link: null });
    expect(shown.title).not.toMatch(/^\d/);
    expect(shown.title).toContain("1h ago");
  });

  it("judges the optional features apart from the required checks", async () => {
    const { win, required, optional } = mountWithRun({ checkedAt: CHECKED, results: [row("github.installation", "pass"), feature("github.skills-repo", "fail")] });
    await win.loadMappings();
    expect(marker(required()).label).toBe("Pass");
    expect(marker(optional())).toMatchObject({ badge: "badge fail", label: "Fail", link: null });
  });

  // One pointer for the page rather than a link per marker, since the Setup page lists every project.
  it("points to the Setup page once, counting each checked project with a marker that does not pass", async () => {
    const { win, note } = mountWithRun({
      checkedAt: CHECKED,
      results: [
        row("github.installation", "pass"),
        feature("github.skills-repo", "warn", { project: "SAN" }),
        row("github.permissions", "fail", { project: "TEST" }),
        row("github.permissions", "fail", { project: "TEST", id: "github.installation" }),
        row("tracker.linear.credentials", "fail", { project: undefined }),
      ],
    }, 200, null, ["AII", "SAN", "TEST", "NEW"]);
    await win.loadMappings();
    expect(note().hidden).toBe(false);
    // SAN and TEST: TEST's two failing rows count once, AII passes, NEW was never checked, and an orchestrator row is no project's.
    expect(note().querySelector("#projects-setup-note-count")!.textContent).toMatch(/^2\b/);
    expect(note().querySelectorAll('a[href="#setup"]')).toHaveLength(1);
    expect(note().ownerDocument.querySelectorAll('#mappings-body a[href="#setup"]')).toHaveLength(0);
  });

  it.each([
    ["every checked project passes", { checkedAt: CHECKED, results: [row("github.installation", "pass"), row("github.target-secrets", "cannot-verify", { verifiable: false })] }, 200],
    ["no run has checked a project", null, 200],
    ["the stored run cannot be read", { checkedAt: CHECKED, results: [row("github.installation", "fail")] }, 503],
  ] as [string, Run | null, number][])("shows no pointer when %s", async (_case, run, status) => {
    const { win, note } = mountWithRun(run, status);
    await win.loadMappings();
    expect(note().hidden).toBe(true);
  });

  it("lets neither a row that does not apply nor a check that can never be verified move a marker", async () => {
    const { win, required, optional } = mountWithRun({
      checkedAt: CHECKED,
      results: [
        row("github.installation", "pass"),
        row("github.target-secrets", "cannot-verify", { tier: "mode", verifiable: false }),
        row("tracker.filesystem.directory", "not-applicable", { tier: "mode" }),
        feature("github.review-process", "cannot-verify", { verifiable: false }),
        feature("github.skills-repo", "not-applicable"),
      ],
    });
    await win.loadMappings();
    expect(marker(required()).label).toBe("Pass");
    // A placeholder rather than a marker, which an unchecked project's empty cell is told apart from.
    expect(optional().querySelector(".badge")).toBeNull();
    expect(optional().textContent).not.toBe("");
  });

  it("leaves other projects' rows and the orchestrator-wide rows out", async () => {
    const { win, required } = mountWithRun({
      checkedAt: CHECKED,
      results: [row("github.installation", "pass"), row("github.installation", "fail", { project: "SAN" }), row("tracker.linear.credentials", "fail", { project: undefined })],
    });
    await win.loadMappings();
    expect(marker(required()).label).toBe("Pass");
  });

  it("dates the markers by the project's own run when one has checked it since the full run", async () => {
    const { win, required } = mountWithRun({ checkedAt: CHECKED - 24 * 60 * 60 * 1000, results: [row("github.permissions", "pass", { checkedAt: CHECKED })] });
    await win.loadMappings();
    expect(marker(required()).title).toContain("1h ago");
  });

  // A recheck refreshes one row, so the project's other rows can be older than its newest.
  it("dates the markers by the project's oldest row", async () => {
    const rechecked = row("github.installation", "fail", { checkedAt: CHECKED + 50 * 60 * 1000 });
    const { win, required } = mountWithRun({ checkedAt: CHECKED, results: [rechecked, row("github.permissions", "pass")] });
    await win.loadMappings();
    expect(marker(required()).title).toContain("1h ago");
  });
});

describe("projects page sync poll — the project's setup checks", () => {
  /** The page with one sync poll started for AII, whose status read answers `job` (or the HTTP `status`), and a record of every call in order. */
  function startPoll(job: unknown, status = 200, projectRun: () => Promise<unknown> = async () => ({})) {
    const calls: string[] = [];
    let tick!: () => Promise<void>;
    const { win } = mountAdminPage({
      html: projectsHtml,
      script: projectsScript,
      route: "projects",
      api: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? " " + init.body : ""}`);
        if (url.includes("/sync-status/")) return { ok: status < 400, status, json: async () => job };
        if (url === "/api/setup-checks/project") await projectRun();
        if (url === "/api/mappings") return { ok: true, status: 200, json: async () => ({ AII: makeMapping() }) };
        return { ok: true, status: 200, json: async () => ({ run: null }) };
      },
      // The poll's interval is driven by hand, one tick at a time.
      before: (w) => {
        w.setInterval = (fn: () => Promise<void>) => { tick = fn; return 1; };
        w.clearInterval = () => {};
        w.alert = () => {};
      },
    });
    win.pollSyncStatus("AII", "job-1");
    return { calls, tick: () => tick() };
  }

  const PROJECT_RUN = 'POST /api/setup-checks/project {"project":"AII"}';

  it.each([
    ["completed", { status: "completed", result: { prUrl: null } }],
    ["failed", { status: "failed", error: { message: "permission denied" } }],
  ])("runs the project's checks once a sync has %s, before the table redraws", async (_name, job) => {
    const { calls, tick } = startPoll(job);
    await tick();
    const run = calls.indexOf(PROJECT_RUN);
    expect(run).toBeGreaterThan(-1);
    expect(calls.indexOf("GET /api/mappings", run)).toBeGreaterThan(run);
    expect(calls.filter((call) => call === PROJECT_RUN)).toHaveLength(1);
  });

  it("does not run them while the sync is still going", async () => {
    const { calls, tick } = startPoll({ status: "running" });
    await tick();
    expect(calls).not.toContain(PROJECT_RUN);
  });

  it("does not run them when the sync job is gone, or the poll gives up waiting", async () => {
    const gone = startPoll({}, 404);
    await gone.tick();
    expect(gone.calls).not.toContain(PROJECT_RUN);
    expect(gone.calls).toContain("GET /api/mappings");

    const waiting = startPoll({ status: "running" });
    for (let attempt = 0; attempt <= 60; attempt++) await waiting.tick();
    expect(waiting.calls).not.toContain(PROJECT_RUN);
  });

  it("still redraws the table when the project's checks cannot run", async () => {
    const { calls, tick } = startPoll({ status: "completed", result: { prUrl: null } }, 200, async () => {
      throw new Error("Restate unavailable");
    });
    await tick();
    expect(calls.slice(calls.indexOf(PROJECT_RUN))).toContain("GET /api/mappings");
  });
});

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

describe("projects page mandatory Restate", () => {
  it.each([null, "legacy", "restate"] as const)("edits a mapping with historical lifecycle %s without offering or sending a lifecycle choice", async (reviewFixLifecycle) => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewFixLifecycle }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    expect(doc.getElementById("md-review-fix-lifecycle")).toBeNull();
    (doc.getElementById("md-review-process") as HTMLSelectElement).value = "codex-code-review";
    await save(win);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ reviewProcess: "codex-code-review" });
    expect(posts[0]).not.toHaveProperty("reviewFixLifecycle");
  });

  it("recovers from a rejected save request (network failure) without leaving the button stuck", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ reviewFixLifecycle: "legacy" }));
    await win.loadMappings();
    win.openMappingDialog("AII");

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


  it("keeps a failed project save visible without retrying or changing settings", async () => {
    const { win, doc, posts } = mountProjects();
    await win.loadMappings();
    win.openMappingDialog("AII");
    const origApi = win.api;
    win.api = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/mappings" && init?.method === "POST") {
        return { ok: false, status: 400, json: async () => ({ error: "maxTurns must be a positive integer or null" }) };
      }
      return origApi(url, init);
    };
    await save(win);
    expect(posts).toEqual([]);
    expect(doc.getElementById("md-error")?.textContent).toContain("maxTurns must be a positive integer or null");
    expect(doc.querySelector<HTMLDialogElement>("#mapping-dialog")!.open).toBe(true);
  });
});

describe("projects page review process and trusted review authors", () => {
  it("declares both controls with the exact hints", () => {
    expect(projectsHtml).toContain('id="md-review-process"');
    expect(projectsHtml).toContain('<option value="ai-implement">AI-Implement</option>');
    expect(projectsHtml).toContain('<option value="claude-code-review">Claude Code Review</option>');
    expect(projectsHtml).toContain('<option value="claude-code-review-repository-fix">Claude Code Review, repository auto-fix</option>');
    expect(projectsHtml).toContain("Who reviews this project's PRs and who fixes. Claude Code Review trusts claude[bot], reads the verdict from the review check run and Claude's inline comments, and keeps AI-Implement's fix attempt. Claude Code Review, repository auto-fix reads the same way but leaves Claude's findings to the repository's own auto-fix, and approves only when the auto-fix commit's review is clean. Applies to every project; Restate coordinates AI-Implement fix attempts on every backend.");
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
    profileStatus: "active",
    account: { readiness: "ready", failureCode: null },
    ...overrides,
  });

  function mountAgents(opts: { defaults?: Mapping; stored?: Mapping; accounts?: Mapping[]; put?: { status: number; body: Mapping }; refusedSave?: { status: number; body: unknown } } = {}) {
    const m = mountProjects(makeMapping({ executionMode: "fly-machines" }), { save: opts.refusedSave });
    const calls: { url: string; method: string; body: unknown }[] = [];
    const base = m.win.api;
    m.win.api = async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/api/mappings/AII/agent-config" && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ projectKey: "AII", enabled: false, mode: "legacy", stages: {}, ...opts.stored }) };
      }
      if (url === "/api/agent-defaults") return { ok: true, status: 200, json: async () => opts.defaults ?? defaults };
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

  // A stage control's own field can share a setting's name, as provider does, and must never decide where that setting's refusal goes.
  it("opens AI Provider's tab for its refusal with the stage controls rendered ahead of it", async () => {
    const m = mountAgents({ refusedSave: { status: 400, body: { error: "The setting was refused.", field: "provider" } } });
    await open(m);
    const panel = (name: string) => m.doc.querySelector(`[data-md-panel="${name}"]`)!;
    panel("ticketing").before(panel("agents"));
    expect(field(m.doc, "value", "planning", "provider")).not.toBeNull();
    m.win.switchMappingTab("source");
    await m.win.saveMappingDialog();
    expect((m.doc.querySelector("#md-tabs [data-md-tab].active") as HTMLElement).dataset.mdTab).toBe("provider");
  });

  it.each(["legacy", "configured"])("saves and reloads the A/B test checkbox in %s mode", async (mode) => {
    const stored: Mapping = { mode, stages: {} };
    const m = mountAgents({ stored });
    await open(m);
    const checkbox = () => m.doc.querySelector<HTMLInputElement>("#md-agents-ab-test")!;
    expect(m.doc.querySelectorAll("#md-agents-ab-test")).toHaveLength(1);
    expect(checkbox().closest("label")!.textContent).toContain("A/B test: divide issues between row 1 and row 2 of the account list");
    expect(checkbox().parentElement!.nextElementSibling!.textContent).toBe("Not active yet. The value is saved, and no run uses it.");
    expect(checkbox().checked).toBe(false);
    expect(m.doc.getElementById("md-agents-save")!.textContent).toBe("Save agent settings");
    for (const value of [true, false]) {
      checkbox().checked = value;
      fire(m.doc, checkbox());
      // A normal stage rerender must retain the checkbox draft.
      fire(m.doc, field(m.doc, "mode", "review", "model"));
      expect(checkbox().checked).toBe(value);
      stored.stages = { implementation: { abTest: value } };
      await m.win.saveAgentConfig();
      expect(puts(m).at(-1)!.body).toEqual({ stages: { implementation: { abTest: value } } });
      await open(m);
      expect(checkbox().checked).toBe(value);
    }
  });

  const claudeAccount = (overrides: Mapping = {}) => account({
    profileId: "acct-claude", agent: "claude", provider: "anthropic", authMode: "claude-subscription", ...overrides,
  });
  const claudeDefaults = {
    ...defaults,
    stages: Object.fromEntries(Object.entries(defaults.stages).map(([stage, values]) => [
      stage, { ...values, agent: "claude", provider: "anthropic", model: "claude-default", accountProfileId: "acct-claude" },
    ])),
  };

  it("offers compatible active setup-token profiles for inherited and overridden selections", async () => {
    const m = mountAgents({ defaults: claudeDefaults, accounts: [
      claudeAccount(),
      claudeAccount({ profileId: "disabled", profileStatus: "disabled" }),
      claudeAccount({ profileId: "inactive", profileStatus: "inactive" }),
      claudeAccount({ profileId: "wrong-agent", agent: "codex" }),
      claudeAccount({ profileId: "wrong-provider", provider: "bedrock" }),
    ] });
    await open(m);
    expect(m.doc.querySelector("[data-ag-problem]")).toBeNull();
    expect(preview(m.doc, "review", "accountProfileId")).toContain("acct-claude (source: orchestrator default)");
    expect(field(m.doc, "value", "review", "accountProfileId").disabled).toBe(true);
    const mode = field(m.doc, "mode", "review", "accountProfileId");
    mode.value = "override";
    fire(m.doc, mode);
    const select = field(m.doc, "value", "review", "accountProfileId");
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("acct-claude");
    expect([...select.options].map((o) => o.value)).toEqual(["", "acct-claude"]);
  });

  it.each(["configured", "legacy"])("shows read-only %s mode and keeps overrides and save", async (mode) => {
    const m = mountAgents({ stored: { mode } });
    await open(m);
    expect(m.doc.getElementById("md-agents-enabled")).toBeNull();
    expect(m.doc.getElementById("md-agents-mode")!.textContent).toBe("Mode: " + mode + ". An admin changes it with the tool set_project_agent_mode.");
    expect(m.doc.getElementById("md-agents-stages")!.children).toHaveLength(3);
    expect((m.doc.getElementById("md-agents-save") as HTMLButtonElement).disabled).toBe(false);
    expect(m.doc.body.textContent).not.toMatch(/opt in|opt-in|opts in|opted-in/i);
  });

  it("preserves a stored setup-token selection when saving an enabled project's stage change", async () => {
    const m = mountAgents({ defaults: claudeDefaults, accounts: [claudeAccount()],
      stored: { enabled: true, stages: { review: { accountProfileId: "acct-claude" } } },
    });
    await open(m);
    expect(field(m.doc, "value", "review", "accountProfileId").value).toBe("acct-claude");
    expect(preview(m.doc, "review", "accountProfileId")).toContain("(source: project)");
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
    const input = field(m.doc, "value", "review", "model");
    input.value = "claude-custom";
    input.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    await m.win.saveAgentConfig();
    expect(puts(m)).toEqual([{ url: "/api/mappings/AII/agent-config", method: "PUT", body: { stages: { review: { model: "claude-custom" } } } }]);
  });

  it("shows missing setup-token readiness and lets the server refuse a stage save safely", async () => {
    const error = "Missing credential <img src=x onerror=alert(1)>";
    const m = mountAgents({ defaults: claudeDefaults,
      accounts: [claudeAccount({ account: { readiness: "missing", failureCode: "credential_missing" } })],
      put: { status: 422, body: { error, code: "credential_missing" } },
    });
    await open(m);
    expect(m.doc.querySelector('[data-ag-profile="acct-claude"]')!.textContent).toContain("readiness: missing (credential_missing)");
    expect(m.doc.querySelector("[data-ag-problem]")).toBeNull();
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
    await m.win.saveAgentConfig();
    expect(puts(m)).toEqual([{ url: "/api/mappings/AII/agent-config", method: "PUT", body: { stages: { review: { model: "claude-default" } } } }]);
    const err = m.doc.getElementById("md-agents-error")!;
    expect(err.textContent).toBe(error);
    expect(err.querySelector("img")).toBeNull();
    expect(m.doc.querySelector('[data-md-panel="agents"] input[type="password"]')).toBeNull();
  });

  it.each(["configured", "legacy"])("saves only changed stages for %s projects", async (modeValue) => {
    const m = mountAgents({ stored: { mode: modeValue } });
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
    expect(puts(m)[0].body).toEqual({ stages: { review: { model: "gpt-custom" } } });
    expect(m.calls.some((c) => c.url === "/api/agent-defaults" && c.method !== "GET")).toBe(false);
  });

  it("previews inherited fallback text safely through rerenders", async () => {
    const value = '"<img src=x onerror="alert(1)">';
    const m = mountAgents({ defaults: { ...defaults, stages: { ...defaults.stages, review: { ...defaults.stages.review, fallbackModel: value } } } });
    await open(m);
    expect(preview(m.doc, "review", "fallbackModel")).toContain(value + " (source: orchestrator default)");
    const mode = field(m.doc, "mode", "review", "fallbackModel");
    mode.value = "override";
    fire(m.doc, mode);
    expect(field(m.doc, "value", "review", "fallbackModel").value).toBe(value);
    expect(m.doc.querySelector("#md-agents-stages img")).toBeNull();
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ stages: { review: { fallbackModel: value } } });
  });

  it("loads fallback overrides safely and clears them to inherit", async () => {
    const value = '"<img src=x onerror="alert(1)">';
    const m = mountAgents({ stored: { stages: { review: { fallbackModel: value } } } });
    await open(m);
    expect(field(m.doc, "value", "review", "fallbackModel").value).toBe(value);
    expect(preview(m.doc, "review", "fallbackModel")).toContain(value);
    for (const stage of ["planning", "implementation", "review"]) {
      expect(field(m.doc, "value", stage, "fallbackModel").parentElement!.textContent).toContain("Used for the rest of the run after this stage's model reports it is at capacity.");
    }
    const mode = field(m.doc, "mode", "review", "fallbackModel");
    mode.value = "inherit";
    fire(m.doc, mode);
    expect(preview(m.doc, "review", "fallbackModel")).toContain("not set");
    expect(m.doc.querySelector("#md-agents-stages img")).toBeNull();
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ stages: { review: { fallbackModel: null } } });
  });

  it("saves only the trimmed fallback override and retains refused drafts safely", async () => {
    const value = '"<img src=x onerror="alert(1)">';
    const error = "fallbackModel must differ from model " + value;
    const m = mountAgents({ put: { status: 400, body: { error } } });
    await open(m);
    const mode = field(m.doc, "mode", "review", "fallbackModel");
    mode.value = "override";
    fire(m.doc, mode);
    const input = field(m.doc, "value", "review", "fallbackModel");
    input.value = "  " + value + "  ";
    input.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ stages: { review: { fallbackModel: value } } });
    expect(m.doc.getElementById("md-agents-error")!.textContent).toBe(error);
    expect(field(m.doc, "value", "review", "fallbackModel").value).toBe("  " + value + "  ");
    expect(preview(m.doc, "review", "fallbackModel")).toContain(value);
    expect(m.doc.querySelector("#md-agents-stages img")).toBeNull();
  });

  it("rejects blank fallback overrides with inherit guidance", async () => {
    const m = mountAgents();
    await open(m);
    const mode = field(m.doc, "mode", "review", "fallbackModel");
    mode.value = "override";
    fire(m.doc, mode);
    const input = field(m.doc, "value", "review", "fallbackModel");
    input.value = "   ";
    input.dispatchEvent(new m.doc.defaultView!.Event("input", { bubbles: true }));
    await m.win.saveAgentConfig();
    expect(puts(m)).toHaveLength(0);
    expect(m.doc.getElementById("md-agents-error")!.textContent).toContain("switch it to Inherit");
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

  it.each(["configured", "legacy"])("sends only stages with null clears for %s", async (modeValue) => {
    const m = mountAgents({ stored: { mode: modeValue, stages: { review: { model: "gpt-custom" } } } });
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

  it("lists every active profile in both the profile list and the stage select", async () => {
    const m = mountAgents({
      accounts: [
        account({ profileId: "acct-a" }),
        account({ profileId: "acct-b" }),
        account({ profileId: "acct-off", profileStatus: "inactive" }),
      ],
    });
    await open(m);
    const listed = [...m.doc.querySelectorAll("[data-ag-profile]")].map((e) => e.getAttribute("data-ag-profile"));
    expect(listed).toEqual(["acct-a", "acct-b"]);
    const options = [...m.doc.querySelectorAll('select[data-stage="review"][data-field="accountProfileId"] option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
    expect(options).not.toContain("acct-off");
  });
  it.each(["claude", "codex"])("offers compatible OpenRouter accounts for %s", async (agent) => {
    const m = mountAgents({ accounts: [
      account({ profileId: "router", agent, provider: "openrouter", authMode: "openrouter-api-key" }),
      account({ profileId: "disabled", agent, provider: "openrouter", profileStatus: "disabled" }),
      account({ profileId: "other-agent", agent: agent === "claude" ? "codex" : "claude", provider: "openrouter" }),
      account(),
    ] });
    await open(m);
    for (const [name, value] of [["agent", agent], ["provider", "openrouter"], ["accountProfileId", "router"]]) {
      const mode = field(m.doc, "mode", "review", name);
      mode.value = "override";
      fire(m.doc, mode);
      const control = field(m.doc, "value", "review", name);
      control.value = value;
      expect(control.value).toBe(value);
      fire(m.doc, control);
    }
    expect(Array.from(field(m.doc, "value", "review", "accountProfileId").querySelectorAll("option"), o => o.value)).toEqual(["", "router"]);
  });

  it("lists only active, compatible profiles and shows readiness without retired session recovery", async () => {
    const m = mountAgents({
      accounts: [
        account(),
        account({ profileId: "acct-off", profileStatus: "disabled" }),
        account({ profileId: "acct-claude", agent: "claude", provider: "anthropic", authMode: "claude-subscription", account: { readiness: "sign-in required", failureCode: "authentication_required" } }),
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
    expect(panel.querySelector('[data-ag-profile="acct-claude"]')!.textContent).toContain("readiness: sign-in required (authentication_required)");
    expect(text).not.toContain("session recovery");
    expect(panel.querySelector('[data-ag-profile="acct-off"]')).toBeNull();
    expect(text).toContain("readiness: missing (x)");
  });

  it.each([
    [409, "delivery_unreadable", "The workflow files could not be read. Run the workflow sync and try again."],
    [409, "readiness_unavailable", "Readiness could not be checked"],
    [503, "readiness_unavailable", "Readiness could not be checked"],
    [409, "stale_inputs", "refreshed"],
    [422, "resolution_failed", "do not resolve"],
  ])("retains drafts or refreshes stale inputs and shows fixed copy for %i %s", async (status, code, copy) => {
    const m = mountAgents({ put: { status, body: { error: "<b>raw</b> secret-ish", code } } });
    await open(m);
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
    await m.win.saveAgentConfig();
    expect(puts(m)[0].body).toEqual({ stages: { review: { model: "gpt-default" } } });
    expect(field(m.doc, "mode", "review", "model").value).toBe(code === "stale_inputs" ? "inherit" : "override");
    const err = m.doc.getElementById("md-agents-error")!;
    expect(err.textContent).toContain(copy);
    expect(err.textContent).not.toContain("raw");
  });

  it.each(["runner_incompatible", "retired_workflow_present", "delivery_unreadable"])("shows the action string for GitHub Actions %s", async (code) => {
    const m = mountAgents({ put: { status: 409, body: { code, action: "Run the existing workflow sync." } } });
    await open(m);
    const mode = field(m.doc, "mode", "review", "model");
    mode.value = "override";
    fire(m.doc, mode);
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
    expect(m.doc.getElementById("md-agents-new")!.textContent).toContain("Save the mapping first");
    expect(m.doc.getElementById("md-agents-new")!.classList.contains("hidden")).toBe(false);
  });

  it("leaves the mapping save payload free of agent fields", async () => {
    const m = mountAgents();
    await open(m);
    await save(m.win);
    expect(JSON.stringify(m.posts[0])).not.toMatch(/agent|stages/i);
    expect(puts(m)).toHaveLength(0);
  });
});

describe("the Edit dialog's Jira repository values", () => {
  // Whoever administers the Jira field names its options, so a quote in one must stay inside its option.
  const VALUE = 'acme/app"><option value="injected';

  it("lists each option as one choice, its value and its text as Jira has them", async () => {
    const { win, doc } = mountAdminPage({
      html: projectsHtml,
      script: projectsScript,
      route: "projects",
      api: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith("/api/jira/field-options") ? [{ value: VALUE }] : {}) }),
    });
    const field = doc.getElementById("md-jira-repo-field") as HTMLSelectElement;
    field.innerHTML = '<option value="customfield_1">Repo</option>';
    await win.onRepoFieldChange();
    const options = Array.from((doc.getElementById("md-jira-repo-value") as HTMLSelectElement).options);
    expect(options.map((o) => [o.value, o.textContent])).toEqual([["", "(none, matches the repository)"], [VALUE, VALUE]]);
  });
});

describe("the Edit dialog's repository", () => {
  const JIRA = { kind: "jira" as const, jql: "project = APP", statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null };
  async function open(mapping: RepoMapping) {
    const m = mountProjects(mapping);
    await m.win.loadMappings();
    m.win.openMappingDialog("AII");
    return m;
  }
  const field = (m: Awaited<ReturnType<typeof open>>, id: string) => m.doc.getElementById(id) as HTMLInputElement;

  it("shows owner/repo in one box, and saves a pasted address as its two parts", async () => {
    const m = await open(makeMapping({ owner: "acme", repo: "widgets" }));
    expect(field(m, "md-github-repo").value).toBe("acme/widgets");
    field(m, "md-github-repo").value = "https://github.com/acme/gadgets/";
    await save(m.win);
    expect(m.posts[0]).toMatchObject({ owner: "acme", repo: "gadgets" });
  });

  it.each([["gadgets", "must be owner/repo"], ["", "is required"]])("refuses %j as the repository, and saves nothing", async (value, message) => {
    const m = await open(makeMapping({ owner: "acme", repo: "widgets" }));
    field(m, "md-github-repo").value = value;
    await save(m.win);
    expect(m.posts).toHaveLength(0);
    expect(m.doc.getElementById("md-error")!.textContent).toContain(message);
  });

  it.each([
    ["a blank one as null", null, null],
    ["an explicit one as entered", "Frontend Service", "Frontend Service"],
  ])("saves a Jira project's Repo Field Value, %s", async (_label, stored, saved) => {
    const m = await open(makeMapping({ owner: "acme", repo: "widgets", ticketingProvider: "jira", ticketingConfig: { ...JIRA, repoFieldValue: stored } }));
    await save(m.win);
    expect(m.posts[0]).toMatchObject({ ticketingProvider: "jira", ticketingConfig: { kind: "jira", repoFieldValue: saved } });
  });

  it("warns after Validate when the JQL names the repo field", async () => {
    const m = await open(makeMapping({ ticketingProvider: "jira", ticketingConfig: { ...JIRA, repoFieldValue: null } }));
    field(m, "md-jira-jql").value = 'project = APP AND "AI-Implement Repo" = "acme/widgets"';
    await m.win.validateJqlButton();
    expect(m.doc.getElementById("md-jira-jql-status")!.textContent).toMatch(/^⚠ Valid\. The JQL names the AI-Implement Repo field\./);
  });
});

describe("projects Fly CPU kind", () => {
  it.each(["performance", undefined] as const)("loads %s and saves the selected kind", async (machineCpuKind) => {
    const { win, doc, posts } = mountProjects(makeMapping({ executionMode: "fly-machines", machineCpuKind }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    const select = doc.querySelector<HTMLSelectElement>("#md-cpu-kind")!;
    expect(select.value).toBe(machineCpuKind ?? "shared");
    expect(select.closest("#md-fly-fields")?.classList.contains("hidden")).toBe(false);
    expect(Array.from(select.options, (o) => o.value)).toEqual(["shared", "performance"]);
    expect(select.nextElementSibling?.textContent).toBe("Fly limits a shared CPU. Use performance for a project whose tests use the CPU for more than some minutes. Performance needs 2048 MB or more for each CPU.");
    select.value = "performance";
    await save(win);
    expect(posts[0]).toMatchObject({ machineCpuKind: "performance", machineCpus: 2, machineMemoryMb: 4096 });
  });

  it("retains Fly values after a server refusal and allows correction", async () => {
    const { win, doc, posts } = mountProjects(makeMapping({ executionMode: "fly-machines" }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    const field = (id: string) => doc.getElementById(id) as HTMLInputElement;
    field("md-cpu-kind").value = "performance";
    field("md-cpus").value = "4";
    field("md-mem").value = "2048";
    const api = win.api;
    const error = "Performance needs more memory <b>per CPU</b>";
    win.api = async () => ({ ok: false, status: 400, json: async () => ({ error }) });
    await save(win);
    expect(doc.getElementById("md-error")?.textContent).toContain(error);
    expect(doc.querySelector("#md-error b")).toBeNull();
    expect(doc.querySelector<HTMLDialogElement>("#mapping-dialog")!.open).toBe(true);
    expect(["md-cpu-kind", "md-cpus", "md-mem"].map((id) => field(id).value)).toEqual(["performance", "4", "2048"]);
    field("md-mem").value = "8192";
    win.api = api;
    await save(win);
    expect(posts[0]).toMatchObject({ machineCpuKind: "performance", machineCpus: 4, machineMemoryMb: 8192 });
  });

  it.each(["github-actions", "filesystem"])("hides the kind with Fly fields for %s", async (mode) => {
    const { win, doc } = mountProjects(makeMapping(mode === "filesystem"
      ? { ticketingProvider: "filesystem", ticketingConfig: { kind: "filesystem", directory: "/tickets" } }
      : { executionMode: "github-actions" }));
    await win.loadMappings();
    win.openMappingDialog("AII");
    expect(doc.getElementById("md-cpu-kind")!.closest("#md-fly-fields")!.classList.contains("hidden")).toBe(true);
  });
});
