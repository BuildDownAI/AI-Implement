import { describe, expect, it } from "vitest";
import { setupHtml, setupScript } from "../pages/setup.js";
import { mountAdminPage, type FakeApiResponse } from "../../__tests__/helpers/fixtures/admin-ui.js";
import { SETUP_CHECK_GROUP_LABELS } from "../../setup-checks/index.js";
import { componentsCss } from "../components.js";

type Row = { id: string; title: string; group: string; tier: string; onAdminPath: boolean; state: string; project?: string; detail?: string; fix?: string; fixUrl?: string };

const row = (over: Partial<Row>): Row => ({ id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: false, state: "pass", ...over });
const body = (over: Record<string, unknown>) => ({ run: null, progress: null, groups: SETUP_CHECK_GROUP_LABELS, ...over });
const reply = (status: number, json: unknown): FakeApiResponse => ({ ok: status >= 200 && status < 300, status, json: async () => json });

/** Mounts the page with replies in order for GET /api/setup-checks, records every timer delay, and fires none. */
function mount(gets: Array<FakeApiResponse | Promise<FakeApiResponse>>, options: { admin?: boolean; post?: FakeApiResponse } = {}) {
  const delays: number[] = [];
  const posts: string[] = [];
  const queue = [...gets];
  const { win, doc } = mountAdminPage({
    html: setupHtml,
    script: setupScript,
    route: "setup",
    api: async (url, init) => {
      if (url === "/api/setup-checks/run" && init?.method === "POST") {
        posts.push(url);
        return options.post ?? reply(202, { invocationId: "inv_1" });
      }
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    before: (w) => {
      w.isAdmin = () => options.admin ?? true;
      w.setTimeout = (_fn: unknown, ms: number) => { delays.push(ms); return 0; };
      w.setInterval = () => 0;
    },
  });
  const el = (id: string) => doc.getElementById(id) as HTMLElement;
  const cards = () => [...doc.querySelectorAll("#setup-groups > .card")] as HTMLElement[];
  return { win, doc, el, cards, delays, posts };
}

/** A stylesheet rule's declarations, with the stylesheet's comments left out. */
function cssRule(selector: string): string {
  const css = componentsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("setup page", () => {
  it("offers the first run to an admin, and tells a user an admin can start one", async () => {
    const admin = mount([reply(200, body({}))]);
    await admin.win.loadSetup();
    expect(admin.el("setup-never-run").hidden).toBe(false);
    expect(admin.el("setup-run-first-btn").hidden).toBe(false);
    expect(admin.el("setup-kpis").hidden).toBe(true);

    const user = mount([reply(200, body({}))], { admin: false });
    await user.win.loadSetup();
    expect(user.el("setup-run-first-btn").hidden).toBe(true);
    expect(user.el("setup-never-run-hint").textContent).toMatch(/admin/);
    expect(user.el("setup-run-btn").hidden).toBe(true);
  });

  it("shows a user the last run without the Run button, since starting one is an admin's", async () => {
    const user = mount([reply(200, body({ run: { checkedAt: 1, results: [row({ state: "fail" })] } }))], { admin: false });
    await user.win.loadSetup();
    expect(user.el("setup-kpis").hidden).toBe(false);
    expect(user.el("setup-run-btn").hidden).toBe(true);
  });

  it("shows the unreadable notice and nothing else when Restate cannot serve", async () => {
    const m = mount([reply(503, { error: "restate-unavailable" })]);
    await m.win.loadSetup();
    expect(m.el("setup-unreadable").hidden).toBe(false);
    expect(m.el("setup-command-line").hidden).toBe(true);
    expect(m.el("setup-kpis").hidden).toBe(true);
    expect(m.el("setup-never-run").hidden).toBe(true);
  });

  it("names the setup command the route sends, as text", async () => {
    const command = 'fly ssh console -a <b>acme</b> -C "node /app/dist/check-setup.js"';
    const m = mount([reply(503, { error: "restate-unavailable", setupCommand: command })]);
    await m.win.loadSetup();
    expect(m.el("setup-command-line").hidden).toBe(false);
    expect(m.el("setup-command").textContent).toBe(command);
    expect(m.el("setup-command").querySelector("b")).toBeNull();
  });

  it("counts the last run's rows by state and reports when it ran and how long it took", async () => {
    const run = { startedAt: 1_000, checkedAt: 39_000, results: [
      row({ state: "fail" }), row({ id: "admin.path", state: "warn" }), row({ id: "callback.config", state: "cannot-verify" }),
      row({ id: "env.github-app", state: "pass" }), row({ id: "env.poll-interval", state: "not-applicable" }),
    ] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    expect(["fail", "warn", "cannot-verify", "pass"].map((s) => m.el(`setup-kpi-${s}`).textContent)).toEqual(["1", "1", "1", "1"]);
    expect(m.el("setup-run-label").textContent).toBe("Last run");
    expect(m.el("setup-kpis").firstElementChild!.contains(m.el("setup-run-label"))).toBe(true);
    expect(m.el("setup-run-badge").className).toBe("badge fail");
    expect(m.el("setup-run-unit").textContent).toContain("38s");
    expect(m.el("setup-run-btn").hidden).toBe(false);
  });

  it("shows one card per group with rows, in the route's group order, named by the route", async () => {
    const run = { checkedAt: 1, results: [row({ group: "github", id: "github.clock", state: "fail" }), row({ group: "orchestrator" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    expect(m.cards().map((c) => c.querySelector(".card-title")!.textContent)).toEqual([SETUP_CHECK_GROUP_LABELS.orchestrator, SETUP_CHECK_GROUP_LABELS.github]);
    // Each card says what it covers under its name, and no two say the same.
    const context = m.cards().map((c) => c.querySelector(".card-subtitle")?.textContent ?? "");
    expect(context.every(Boolean) && new Set(context).size === context.length).toBe(true);
  });

  it("lists open rows worst first, then folds passing and not-applicable rows into the same table", async () => {
    const run = { checkedAt: 1, results: [
      row({ title: "W", state: "warn" }), row({ title: "F", state: "fail" }),
      row({ title: "C", state: "cannot-verify" }), row({ title: "OK", state: "pass" }), row({ title: "NA", state: "not-applicable" }),
    ] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const [card] = m.cards();
    const rows = [...card.querySelectorAll("tbody tr")] as HTMLElement[];
    const title = (tr: HTMLElement) => tr.children[0].querySelector("div")?.textContent;
    expect(rows.filter((tr) => !tr.hidden && !tr.classList.contains("setup-fold-row")).map(title)).toEqual(["F", "C", "W"]);
    expect(card.querySelector(".setup-fold")!.textContent).toContain("1 passing, 1 not applicable");
    expect(rows.filter((tr) => tr.hidden).map(title)).toEqual(["OK", "NA"]);
  });

  it("names each check by its id as well as its title, since fixes and the setup command use the id", async () => {
    const m = mount([reply(200, body({ run: { checkedAt: 1, results: [row({ id: "callback.reachable", title: "Runner callback reachable", state: "fail" })] } }))]);
    await m.win.loadSetup();
    const check = m.cards()[0].querySelector("tbody tr td")!;
    expect(check.textContent).toContain("Runner callback reachable");
    expect(check.querySelector(".mono")!.textContent).toBe("callback.reachable");
  });

  it("gives each project a card of its own, after the group cards, its rows worst first, then in group order", async () => {
    const run = { checkedAt: 1, results: [
      row({ title: "Wide", state: "fail" }),
      row({ group: "github", id: "github.installation", title: "Install B", state: "fail", project: "OPS" }),
      row({ group: "github", id: "github.installation", title: "Install A", state: "fail", project: "ENG" }),
      row({ group: "tracker", id: "tracker.linear.pickup-label", title: "Pickup", state: "warn", project: "ENG" }),
      row({ group: "tracker", id: "tracker.linear.team-access", title: "Team access", state: "fail", project: "ENG" }),
    ] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const titles = m.cards().map((c) => c.querySelector(".card-title")!.textContent);
    expect(titles).toEqual([SETUP_CHECK_GROUP_LABELS.orchestrator, "ENG", "OPS"]);
    const checksOf = (c: HTMLElement) => [...c.querySelectorAll("tbody tr")].map((tr) => tr.children[0].querySelector("div")!.textContent);
    expect(checksOf(m.cards()[1])).toEqual(["Team access", "Install A", "Pickup"]);
    expect(checksOf(m.cards()[2])).toEqual(["Install B"]);
    expect(m.cards().every((c) => [...c.querySelectorAll("th")].map((th) => th.textContent).join() === "Check,State,What was found,Fix")).toBe(true);
  });

  it("leaves totals to the tables and the KPIs, so a card's header holds only its name", async () => {
    const run = { checkedAt: 1, results: [row({ state: "fail" }), row({ group: "github", id: "github.installation", state: "warn", project: "ENG" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    expect(m.cards().map((c) => c.querySelectorAll(".card-header .badge").length)).toEqual([0, 0]);
  });

  it("shows a table's header only over rows, so a card whose checks all pass is its name and its fold", async () => {
    const run = { checkedAt: 1, results: [row({ state: "pass" }), row({ group: "github", id: "github.clock", state: "fail" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const heads = () => m.cards().map((c) => c.querySelectorAll("thead").length);
    expect(heads()).toEqual([0, 1]);
    (m.cards()[0].querySelector(".setup-fold") as HTMLButtonElement).click();
    expect(heads()).toEqual([1, 1]);
    // The fold stays above the table it opened, rather than moving below its header.
    const passing = m.cards()[0];
    expect(passing.querySelector(".setup-fold")!.compareDocumentPosition(passing.querySelector("thead")!) & m.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives every table the same fixed column widths, so a fold opening never moves a column", async () => {
    const run = { checkedAt: 1, results: [row({ state: "fail" }), row({ group: "github", id: "github.installation", state: "fail", project: "ENG" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const layouts = m.cards().map((c) => {
      const table = c.querySelector("table")!;
      return `${table.style.tableLayout} ${table.style.minWidth} ` + [...table.querySelectorAll("col")].map((col) => col.style.width).join(",");
    });
    expect(new Set(layouts).size).toBe(1);
    // A minimum width, so a narrow window scrolls the table inside its card instead of squeezing it.
    expect(layouts[0]).toMatch(/^fixed \d+px \d+%,\d+%,\d+%,\d+%$/);
    // The KPI tiles wrap onto another row before they squeeze.
    expect(m.el("setup-kpis").getAttribute("style")).toContain("minmax(");
  });

  it("names the first three running checks in a card and counts the rest", async () => {
    const running = ["a", "b", "c", "d", "e"].map((n) => ({ id: `github.${n}`, title: `Check ${n.toUpperCase()}`, group: "github" }));
    const progress = { startedAt: Date.now(), total: 5, finished: [], running };
    const m = mount([reply(200, body({ progress }))]);
    await m.win.loadSetup();
    expect(m.cards()[0].querySelector(".setup-running-row .text-secondary")!.textContent).toBe("Check A, Check B, Check C, and 2 more");

    const few = mount([reply(200, body({ progress: { ...progress, total: 2, running: running.slice(0, 2) } }))]);
    await few.win.loadSetup();
    expect(few.cards()[0].querySelector(".setup-running-row .text-secondary")!.textContent).toBe("Check A, Check B");
  });

  it("gives check rows no pointer, since a table row shows one only when it opens a job", () => {
    const pointerRules = [...componentsCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*\.tbl tbody tr[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , declarations]) => /cursor:\s*pointer/.test(declarations)).map(([, selector]) => selector.trim());
    expect(pointerRules).toEqual([".tbl tbody tr[data-job-id]"]);
  });

  it("lets a page's header actions wrap below its title and subtitle rather than squeezing them", () => {
    expect(cssRule(".page-header")).toMatch(/flex-wrap:\s*wrap/);
    // The title side keeps a basis wide enough to read before the actions give way.
    expect(cssRule(".page-header-left")).toMatch(/flex:\s*1 1 \d+px/);
  });

  it("escapes every text a row and a card show, links only a fixUrl, and blocks a script URL", async () => {
    const run = { checkedAt: 1, results: [
      row({ state: "fail", title: "<i>title</i>", detail: "<img src=x>", fix: "<b>fix</b>", fixUrl: "javascript:alert(1)" }),
      row({ id: "admin.path", state: "warn", fix: "Plain fix" }),
      // A project's name is the operator's mapping key, so it is text from outside the code too.
      row({ id: "github.installation", group: "github", state: "fail", project: "<u>project</u>" }),
    ] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const [card, projectCard] = m.cards();
    expect(card.querySelector("img, b, i")).toBeNull();
    expect(card.textContent).toContain("<b>fix</b>");
    expect(card.textContent).toContain("<i>title</i>");
    const links = [...card.querySelectorAll("a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#"]);
    expect(projectCard.querySelector("u")).toBeNull();
    expect(projectCard.querySelector(".card-title")?.textContent).toBe("<u>project</u>");
  });

  it("unfolds a table's passing rows on click and keeps them open across a refresh", async () => {
    const run = { checkedAt: 1, results: [row({ state: "fail" }), row({ id: "admin.path", state: "pass" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    const hiddenRows = () => [...m.cards()[0].querySelectorAll("tbody tr")].filter((tr) => (tr as HTMLElement).hidden).length;
    expect(hiddenRows()).toBe(1);
    (m.cards()[0].querySelector(".setup-fold") as HTMLButtonElement).click();
    expect(hiddenRows()).toBe(0);
    await m.win.loadSetup();
    expect(hiddenRows()).toBe(0);
  });

  it("keeps each table's fold to itself, so opening one leaves another open", async () => {
    const run = { checkedAt: 1, results: [row({ state: "pass" }), row({ group: "github", id: "github.clock", state: "pass" })] };
    const m = mount([reply(200, body({ run }))]);
    await m.win.loadSetup();
    (m.cards()[0].querySelector(".setup-fold") as HTMLButtonElement).click();
    (m.cards()[1].querySelector(".setup-fold") as HTMLButtonElement).click();
    expect(m.cards().map((c) => [...c.querySelectorAll("tbody tr")].some((tr) => (tr as HTMLElement).hidden))).toEqual([false, false]);
  });

  it("shows a run in progress: checks finished of the total, finished rows, and each running check by name in its group", async () => {
    const progress = { startedAt: Date.now() - 14_000, total: 3, finished: [row({ state: "fail" })], running: [{ id: "github.clock", title: "GitHub clock", group: "github" }] };
    const m = mount([reply(200, body({ progress }))]);
    await m.win.loadSetup();
    expect(m.el("setup-run-label").textContent).toBe("This run");
    expect(m.el("setup-run-value").textContent).toBe("2 of 3");
    expect(m.el("setup-run-unit").textContent).toMatch(/^1\ds$/);
    expect((m.el("setup-run-btn") as HTMLButtonElement).disabled).toBe(true);
    const github = m.cards().find((c) => c.querySelector(".card-title")!.textContent === SETUP_CHECK_GROUP_LABELS.github)!;
    // Running checks share one line per card rather than a row each, so a run does not lengthen the page.
    expect(github.querySelector(".setup-running-row")!.textContent).toContain("GitHub clock");
    expect(github.querySelector(".setup-running-row .badge.running")!.textContent).toBe("1 running");
    expect(github.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("polls every 5 seconds while a run is going and every 60 otherwise", async () => {
    const running = mount([reply(200, body({ progress: { startedAt: 1, total: 1, finished: [], running: [{ id: "restate", title: "Restate engine", group: "orchestrator" }] } }))]);
    await running.win.loadSetup();
    const idle = mount([reply(200, body({ run: { checkedAt: 1, results: [row({})] } }))]);
    await idle.win.loadSetup();
    expect([running.delays.at(-1), idle.delays.at(-1)]).toEqual([5000, 60000]);
  });

  it("after starting a run, shows it starting and polls fast until the run or its progress appears", async () => {
    const old = { checkedAt: 1, results: [row({})] };
    const fresh = { checkedAt: 2, results: [row({ state: "fail" })] };
    const m = mount([reply(200, body({ run: old })), reply(200, body({ run: old })), reply(200, body({ run: fresh }))]);
    await m.win.loadSetup();
    await m.win.startSetupRun();
    expect(m.posts).toHaveLength(1);
    expect(m.el("setup-run-value").textContent).toBe("Starting");
    expect(m.delays.at(-1)).toBe(5000);
    await m.win.loadSetup();
    expect(m.el("setup-run-label").textContent).toBe("Last run");
    expect(m.delays.at(-1)).toBe(60000);
  });

  it("keeps what a newer load showed when an older load answers after it", async () => {
    let answerOlder!: (answer: FakeApiResponse) => void;
    const older = new Promise<FakeApiResponse>((resolve) => { answerOlder = resolve; });
    const progress = { startedAt: 1, total: 1, finished: [], running: [{ id: "restate", title: "Restate engine", group: "orchestrator" }] };
    const m = mount([older, reply(200, body({ progress }))]);
    // A poll in flight when Run checks is clicked, then the click's own load, which sees the run.
    const polled = m.win.loadSetup();
    await m.win.loadSetup();
    answerOlder(reply(200, body({ run: { checkedAt: 1, results: [row({})] } })));
    await polled;
    expect(m.el("setup-run-label").textContent).toBe("This run");
    expect((m.el("setup-run-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(m.delays).toEqual([5000]);
  });

  it("names a refused start, and treats a 409 as the run already going", async () => {
    const m = mount([reply(200, body({ run: { checkedAt: 1, results: [row({})] } }))], { post: reply(503, { error: "restate-unavailable" }) });
    await m.win.loadSetup();
    await m.win.startSetupRun();
    expect(m.el("setup-error").textContent).toMatch(/Restate/);

    const busy = mount([reply(200, body({ progress: { startedAt: 1, total: 1, finished: [], running: [] } }))], { post: reply(409, { error: "run-in-progress", startedAt: 1 }) });
    await busy.win.startSetupRun();
    expect(busy.el("setup-error").classList.contains("hidden")).toBe(true);
    expect(busy.el("setup-run-label").textContent).toBe("This run");
  });
});
