import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { componentsCss } from "../components.js";
import { helpersJs } from "../helpers.js";
import { blockersScript } from "../pages/blockers.js";
import { deploymentsScript } from "../pages/deployments.js";
import { issuesScript } from "../pages/issues.js";
import { kgPipelinesScript } from "../pages/kg-pipelines.js";
import { overviewScript } from "../pages/overview.js";
import { projectsScript } from "../pages/projects.js";
import { reaperScript } from "../pages/reaper.js";
import { setupScript } from "../pages/setup.js";
import { stepperScript } from "../stepper.js";

/** Runs helpers.ts in a page of its own, as the admin page runs it ahead of every other script. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountHelpers(): any {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { runScripts: "dangerously", url: "http://localhost" });
  const script = dom.window.document.createElement("script");
  script.textContent = helpersJs;
  dom.window.document.head.appendChild(script);
  return dom.window;
}

describe("escAttr", () => {
  it("escapes double quotes so they cannot break a quoted attribute", () => {
    const win = mountHelpers();
    const dangerous = '" onclick="alert(1)';
    const result: string = win.escAttr(dangerous);
    expect(result).not.toContain('"');
    expect(result).toContain("&quot;");
  });

  it("escapes single quotes", () => {
    const win = mountHelpers();
    expect(win.escAttr("it's")).toBe("it&#x27;s");
  });

  it("escapes angle brackets", () => {
    const win = mountHelpers();
    expect(win.escAttr("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("escapes ampersands", () => {
    const win = mountHelpers();
    expect(win.escAttr("a&b")).toBe("a&amp;b");
  });

  it("handles null and undefined as empty string", () => {
    const win = mountHelpers();
    expect(win.escAttr(null)).toBe("");
    expect(win.escAttr(undefined)).toBe("");
  });
});

describe("safeUrl", () => {
  it("blocks javascript: URLs and returns '#'", () => {
    const win = mountHelpers();
    expect(win.safeUrl("javascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: regardless of case", () => {
    const win = mountHelpers();
    expect(win.safeUrl("JAVASCRIPT:alert(1)")).toBe("#");
  });

  it("blocks data: URLs", () => {
    const win = mountHelpers();
    expect(win.safeUrl("data:text/html,<h1>x</h1>")).toBe("#");
  });

  it("passes http: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "http://example.com/path?q=1";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes https: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "https://github.com/owner/repo/pull/42";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes mailto: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "mailto:user@example.com";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes fragment URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("#runners")).toBe("#runners");
  });

  it("passes absolute-path URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("/api/settings")).toBe("/api/settings");
  });

  it("passes relative URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("./page")).toBe("./page");
    expect(win.safeUrl("../up")).toBe("../up");
  });

  it("returns '#' for null", () => {
    const win = mountHelpers();
    expect(win.safeUrl(null)).toBe("#");
  });
});

describe("html tagged template", () => {
  it("escapes interpolated values by default", () => {
    const win = mountHelpers();
    const result: string = win.html`<div>${"<script>alert(1)</script>"}</div>`;
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("escapes double quotes in interpolations (safe in attribute context)", () => {
    const win = mountHelpers();
    const attr = '"evil"';
    const result: string = win.html`<span title="${attr}">x</span>`;
    expect(result).not.toContain('"evil"');
    expect(result).toContain("&quot;evil&quot;");
  });

  it("preserves static template string parts verbatim", () => {
    const win = mountHelpers();
    const result: string = win.html`<div class="card">hello</div>`;
    expect(result).toBe('<div class="card">hello</div>');
  });

  it("raw() opt-out passes markup through unescaped", () => {
    const win = mountHelpers();
    const markup = '<span class="badge success">OK</span>';
    const result: string = win.html`<div>${win.raw(markup)}</div>`;
    expect(result).toBe(`<div>${markup}</div>`);
  });

  it("mixes escaped and raw values in the same template", () => {
    const win = mountHelpers();
    const safe = win.raw('<b>bold</b>');
    const unsafe = '<script>';
    const result: string = win.html`${safe} and ${unsafe}`;
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  describe("URL context detection (href/src)", () => {
    it("blocks javascript: in href interpolation", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href="${"javascript:alert(document.cookie)"}">x</a>`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('href="#"');
    });

    it("blocks javascript: in src interpolation", () => {
      const win = mountHelpers();
      const result: string = win.html`<img src="${"javascript:alert(1)"}">`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('src="#"');
    });

    it("passes https: URL through href unchanged", () => {
      const win = mountHelpers();
      const url = "https://example.com/path";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain(`href="${url}"`);
    });

    it("passes https: URL with query string through href (& encoded per HTML spec)", () => {
      const win = mountHelpers();
      const url = "https://example.com/?a=1&b=2";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain("href=");
      expect(result).not.toContain("javascript:");
      expect(result).toContain("https://example.com/?a=1");
    });

    it("detects href with double-quote delimiter", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href="${"javascript:x"}">x</a>`;
      expect(result).toContain('href="#"');
    });

    it("detects href with spaces around the equals sign", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href = "${"javascript:alert(1)"}">x</a>`;
      expect(result).toBe('<a href = "#">x</a>');
    });

    it("detects href without quote delimiter", () => {
      const win = mountHelpers();
      // href= with no opening quote before the interpolation
      const tmpl = (win as { html: (s: TemplateStringsArray, ...v: unknown[]) => string }).html;
      // Manually exercise via tagged template with no quote
      const strings = Object.assign(["<a href=", ">x</a>"], { raw: ["<a href=", ">x</a>"] }) as unknown as TemplateStringsArray;
      const result: string = tmpl(strings, "javascript:alert(1)");
      expect(result).not.toContain("javascript:");
    });

    it("does not apply safeUrl to non-URL attributes", () => {
      const win = mountHelpers();
      // title= should still just escAttr, not safeUrl (so javascript: string is escaped, not replaced with #)
      const result: string = win.html`<span title="${"javascript:alert(1)"}">x</span>`;
      // escAttr encodes the colon only if needed; javascript: has no chars to escape
      // but it should NOT become '#' — that is safeUrl behaviour, not escAttr behaviour
      expect(result).toContain("javascript:");
      expect(result).not.toContain('title="#"');
    });

    it("raw() still opts out in URL context", () => {
      const win = mountHelpers();
      const markup = win.raw("javascript:alert(1)");
      const result: string = win.html`<a href="${markup}">x</a>`;
      expect(result).toContain("javascript:alert(1)");
    });
  });
});

describe("statusBadge", () => {
  it("puts the dot ahead of the label, so no status badge is written without it", () => {
    const win = mountHelpers();
    expect(win.statusBadge("fail", "Parked")).toBe('<span class="badge fail"><span class="dot"></span>Parked</span>');
  });

  it("escapes the label as text and the kind as an attribute", () => {
    const win = mountHelpers();
    const markup: string = win.statusBadge('warn" onclick="x', "<b>label</b>");
    expect(markup).toContain("&lt;b&gt;label&lt;/b&gt;");
    expect(markup).not.toContain('" onclick');
  });
});

describe("setStatusBadge", () => {
  it("rewrites an element in place, dot included, replacing its earlier kind and label", () => {
    const win = mountHelpers();
    const el = win.document.createElement("span");
    win.setStatusBadge(el, "running", "Building");
    win.setStatusBadge(el, "success", "<Done>");
    expect(el.className).toBe("badge success");
    expect(el.innerHTML).toBe('<span class="dot"></span>&lt;Done&gt;');
  });
});

describe("labelBadge", () => {
  it("writes no dot, so a label never reads as a state", () => {
    const win = mountHelpers();
    expect(win.labelBadge("info", "fly")).toBe('<span class="badge info">fly</span>');
  });

  it("escapes the label as text and the kind as an attribute", () => {
    const win = mountHelpers();
    const markup: string = win.labelBadge('info" onclick="x', "<b>fly</b>");
    expect(markup).toContain("&lt;b&gt;fly&lt;/b&gt;");
    expect(markup).not.toContain('" onclick');
  });
});

describe("fmtAgo", () => {
  const NOW = 1_700_000_000_000;
  const ago = (n: number, unitMs: number) => NOW - n * unitMs;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // The helpers run inside the jsdom window, whose Date is its own, so its clock is the one fixed.
  function mountAt(now: number) {
    const win = mountHelpers();
    win.Date.now = () => now;
    return win;
  }

  it("steps through seconds, minutes and hours", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(ago(45, 1000))).toBe("45s ago");
    expect(win.fmtAgo(ago(12, MIN))).toBe("12m ago");
    expect(win.fmtAgo(ago(5, HOUR))).toBe("5h ago");
    expect(win.fmtAgo(ago(23, HOUR))).toBe("23h ago");
  });

  // A quiet orchestrator's last deploy or run is weeks old,
  // and three weeks read as "504h ago" before this tier existed.
  it("reaches days, so an old event does not read in hundreds of hours", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(ago(24, HOUR))).toBe("1d ago");
    expect(win.fmtAgo(ago(21, DAY))).toBe("21d ago");
    expect(win.fmtAgo(ago(400, DAY))).toBe("400d ago");
  });

  it("takes an ISO string as well as epoch milliseconds", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(new Date(ago(3, HOUR)).toISOString())).toBe("3h ago");
  });

  it("reads a time slightly ahead of this clock as 0s ago rather than a negative count", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(NOW + 3000)).toBe("0s ago");
  });
});

describe("fmtDuration", () => {
  const S = 1000;
  const MIN = 60 * S;

  it("reads in seconds under a minute", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(0)).toBe("0s");
    expect(win.fmtDuration(45 * S)).toBe("45s");
    expect(win.fmtDuration(59 * S)).toBe("59s");
  });

  // A counter that ticks every second has to show the seconds move.
  it("keeps the seconds from one minute up to the hour", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(60 * S)).toBe("1m 0s");
    expect(win.fmtDuration(90 * S)).toBe("1m 30s");
    expect(win.fmtDuration(59 * MIN + 59 * S)).toBe("59m 59s");
  });

  it("switches to hours and minutes at exactly one hour", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(60 * MIN)).toBe("1h 0m");
    expect(win.fmtDuration(95 * MIN)).toBe("1h 35m");
  });

  // The start is stamped by whichever process began the work and read by whichever is alive now,
  // so a host whose clock moved backwards must not render "-3s".
  it("clamps a negative length to zero rather than counting down", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(-3 * S)).toBe("0s");
  });
});

// The Setup page's tests cover escaping, the fix link and the column widths through these helpers.
// What the New project stepper relies on besides is pinned here.
describe("setupCheckRow and setupCheckTable", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "github.installation",
    title: "App installed on the repository",
    state: "fail",
    detail: "The App is not installed on acme.",
    fix: "Install the App.",
    ...overrides,
  });

  function cells(markup: string): HTMLTableCellElement[] {
    const win = mountHelpers();
    const body = win.document.createElement("tbody");
    body.innerHTML = markup;
    return Array.from(body.querySelectorAll("td"));
  }

  it.each([
    ["fail", "badge fail", "Fail"],
    ["cannot-verify", "badge info", "Cannot verify"],
    ["warn", "badge warn", "Warning"],
    ["pass", "badge success", "Pass"],
    ["not-applicable", "badge neutral", "Not applicable"],
  ])("shows a %s row's state as a status badge", (state, className, label) => {
    const win = mountHelpers();
    const [, stateCell] = cells(win.setupCheckRow(row({ state }), false));
    const badge = stateCell.querySelector(".badge")!;
    expect(badge.className).toBe(className);
    expect(badge.querySelector(".dot")).not.toBeNull();
    expect(badge.textContent).toBe(label);
  });

  it("shows a state it does not know by its own name, as a neutral badge", () => {
    const win = mountHelpers();
    const [, stateCell] = cells(win.setupCheckRow(row({ state: "unheard-of" }), false));
    expect(stateCell.querySelector(".badge")!.className).toBe("badge neutral");
    expect(stateCell.textContent).toBe("unheard-of");
  });

  it("hides a row only when asked to", () => {
    const win = mountHelpers();
    expect(win.setupCheckRow(row(), true)).toMatch(/^<tr hidden>/);
    expect(win.setupCheckRow(row(), false)).toMatch(/^<tr>/);
  });

  it("writes the check, its id, what was found and the fix in that order, and an empty fix cell for a row with none", () => {
    const win = mountHelpers();
    const [check, , detail, fix] = cells(win.setupCheckRow(row(), false));
    expect(check.textContent).toBe("App installed on the repositorygithub.installation");
    expect(detail.textContent).toBe("The App is not installed on acme.");
    expect(fix.textContent).toBe("Install the App.");
    const [, , , none] = cells(win.setupCheckRow(row({ fix: undefined, fixUrl: "https://github.com/apps/x" }), false));
    expect(none.innerHTML).toBe("");
  });

  it("wraps the rows it is given in a table headed by the four columns", () => {
    const win = mountHelpers();
    const holder = win.document.createElement("div");
    holder.innerHTML = win.setupCheckTable(win.setupCheckRow(row(), false));
    const heads = Array.from(holder.querySelectorAll("thead th"), (th) => (th as HTMLElement).textContent);
    expect(heads).toEqual(["Check", "State", "What was found", "Fix"]);
    expect(holder.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});

// The stacked form the New project stepper's Review shows, for a container too narrow for the table.
describe("setupCheckItem", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "github.installation",
    title: "App installed on the repository",
    state: "fail",
    detail: "The App is not installed on acme.",
    fix: "Install the App.",
    ...overrides,
  });

  function item(markup: string): HTMLElement {
    const holder = mountHelpers().document.createElement("div");
    holder.innerHTML = markup;
    return holder.firstElementChild as HTMLElement;
  }

  /** Each labeled line as [label, text]. */
  const lines = (el: HTMLElement) =>
    Array.from(el.querySelectorAll(".setup-check-line"), (line) => [line.querySelector(".setup-check-label")!.textContent, line.lastElementChild!.textContent]);

  it("names the check and its id beside its state, then what was found and the fix, each labeled", () => {
    const el = item(mountHelpers().setupCheckItem(row(), false, false));
    expect(el.querySelector(".setup-check-title")!.textContent).toBe("App installed on the repository");
    expect(el.querySelector(".setup-check-id")!.textContent).toBe("github.installation");
    expect(el.querySelector(".badge")!.className).toBe("badge fail");
    expect(lines(el)).toEqual([["Found", "The App is not installed on acme."], ["Fix", "Install the App."]]);
  });

  it("leaves out a line it has nothing for", () => {
    const win = mountHelpers();
    expect(lines(item(win.setupCheckItem(row({ detail: undefined }), false, false)))).toEqual([["Fix", "Install the App."]]);
    expect(lines(item(win.setupCheckItem(row({ fix: undefined }), false, false)))).toEqual([["Found", "The App is not installed on acme."]]);
  });

  it("is hidden and shaded only when asked", () => {
    const win = mountHelpers();
    const plain = item(win.setupCheckItem(row(), false, false));
    const both = item(win.setupCheckItem(row(), true, true));
    expect([plain.hidden, plain.classList.contains("shaded")]).toEqual([false, false]);
    expect([both.hidden, both.classList.contains("shaded")]).toEqual([true, true]);
  });

  it("writes every text from the row as text, and the fix's link through safeUrl", () => {
    const win = mountHelpers();
    const el = item(win.setupCheckItem(row({ title: "<b>t</b>", id: "<b>i</b>", detail: "<b>d</b>", fix: "<b>f</b>", fixUrl: "javascript:alert(1)" }), false, false));
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector(".setup-check-title")!.textContent).toBe("<b>t</b>");
    expect(el.querySelector("a")!.getAttribute("href")).toBe("#");
  });
});

// The Setup page's cards and the stepper's Review show a project's rows waiting on one check as one row.
describe("groupWaitingRows", () => {
  const group = (...rows: Record<string, unknown>[]) => mountHelpers().groupWaitingRows(rows);
  const waiting = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, state: "cannot-verify", detail: "d", fix: "f", waitsOn: "tracker.provider", project: "ENG", ...extra });

  it("shows two or more rows waiting on one check as one row, in the first one's place, naming every check", () => {
    const shown = group({ id: "github.installation", state: "fail" }, waiting("a"), { id: "github.permissions", state: "warn" }, waiting("b"), waiting("c"));
    expect(shown.map((row: { id: string }) => row.id)).toEqual(["github.installation", "a, b, c", "github.permissions"]);
    expect(shown[1]).toMatchObject({ state: "cannot-verify", detail: "d", fix: "f" });
    expect(shown[1].title).toContain("tracker.provider");
  });

  it("leaves a lone waiting row, and every other row, as it is", () => {
    const lone = waiting("a");
    expect(group(lone, { id: "x", state: "pass" })).toEqual([lone, { id: "x", state: "pass" }]);
  });

  it("joins only one project's rows waiting on the same check", () => {
    const shown = group(waiting("a"), waiting("b", { project: "OPS" }), waiting("c", { waitsOn: "github.app-identity" }), waiting("d", { waitsOn: "github.app-identity" }));
    expect(shown.map((row: { id: string }) => row.id)).toEqual(["a", "b", "c, d"]);
  });

  it("keeps a detail the rows share, and says what they wait on when their details differ", () => {
    const [shown] = group(waiting("a", { detail: "one" }), waiting("b", { detail: "two" }));
    expect(shown.detail).not.toBe("one");
    expect(shown.detail).toContain("tracker.provider");
  });
});

// Every setup surface orders and folds rows by the one list here, so a new state or a new order changes them together.
describe("the setup states' order", () => {
  it("is published worst first, the first three needing attention", () => {
    const win = mountHelpers();
    expect(win.SETUP_STATE_ORDER).toEqual(["fail", "cannot-verify", "warn", "pass", "not-applicable"]);
    expect(win.SETUP_ACTIONABLE).toEqual(["fail", "cannot-verify", "warn"]);
  });

  it.each([["setup", setupScript], ["stepper", stepperScript]])("%s defines no order of its own", (_name, script) => {
    expect(script).not.toMatch(/\[\s*'fail',\s*'cannot-verify'/);
  });
});

// The marker rule the Projects page reads for each of a project's two setup cells.
describe("setupVerdict", () => {
  const verdict = (...rows: Record<string, unknown>[]) => mountHelpers().setupVerdict(rows);
  const r = (state: string, extra: Record<string, unknown> = {}) => ({ state, ...extra });

  it("takes the worst state among the rows, one row being enough", () => {
    expect(verdict(r("pass"), r("warn"), r("cannot-verify"), r("fail"))).toEqual({ kind: "fail", label: "Fail", toLook: 3 });
    expect(verdict(r("pass"), r("warn"), r("cannot-verify"))).toEqual({ kind: "info", label: "Cannot verify", toLook: 2 });
    expect(verdict(r("pass"), r("warn"))).toEqual({ kind: "warn", label: "Warning", toLook: 1 });
    expect(verdict(r("pass"), r("pass"))).toEqual({ kind: "success", label: "Pass", toLook: 0 });
  });

  it("judges neither a row that does not apply nor a check that can never be verified", () => {
    expect(verdict(r("pass"), r("not-applicable"), r("cannot-verify", { verifiable: false }))).toEqual({ kind: "success", label: "Pass", toLook: 0 });
  });

  it("has no verdict when nothing is left to judge", () => {
    expect(verdict()).toBeNull();
    expect(verdict(r("not-applicable"), r("fail", { verifiable: false }))).toBeNull();
  });
});

// A page joins a list when a change that touches it moves it onto the shared helpers, so the pages
// still missing are what AII-874 (badges) and AII-872 (time formatters) have left to do.
describe("pages on the shared helpers", () => {
  const onSharedBadges: [string, string][] = [
    ["overview", overviewScript],
    ["issues", issuesScript],
    ["blockers", blockersScript],
    ["deployments", deploymentsScript],
    ["kg-pipelines", kgPipelinesScript],
    ["reaper", reaperScript],
  ];
  const onSharedTime: [string, string][] = [
    ["overview", overviewScript],
    ["deployments", deploymentsScript],
  ];

  it.each(onSharedBadges)("%s writes no badge markup of its own", (_name, script) => {
    expect(script).not.toMatch(/class="badge|className\s*=\s*'badge/);
    expect(script).not.toMatch(/function setBadge\b/);
  });

  // A kind with no stylesheet rule renders a pill with no state color, and nothing else notices.
  // Overview picks its kinds from a status map, so it passes no literal kind to check here.
  const withLiteralKinds = onSharedBadges.filter(([name]) => name !== "overview");
  it.each(withLiteralKinds)("%s passes only badge kinds the stylesheet defines", (_name, script) => {
    const kinds = [...script.matchAll(/(?:setStatusBadge\([^,]+|(?:statusBadge|labelBadge)\()\s*,?\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(componentsCss, kind).toContain(`.badge.${kind} {`);
  });

  it.each(onSharedTime)("%s defines no time formatter of its own", (_name, script) => {
    expect(script).not.toMatch(/function (fmtAgo|fmtDuration|fmtElapsed|fmtRelative)\b/);
  });

  it.each([["stepper", stepperScript], ["projects", projectsScript]])("%s defines no JQL warning or repository parser of its own", (_name, script) => {
    expect(script).not.toMatch(/function (detectStatusFilterInJql|detectRepoFilterInJql|splitGithubRepo)\b/);
  });
});

describe("splitGithubRepo", () => {
  it.each([
    ["acme/backend", { owner: "acme", repo: "backend" }],
    ["  acme / backend  ", { owner: "acme", repo: "backend" }],
    ["https://github.com/acme/backend", { owner: "acme", repo: "backend" }],
    ["https://www.github.com/acme/backend.git", { owner: "acme", repo: "backend" }],
    ["acme/backend.git/", { owner: "acme", repo: "backend" }],
    ["acme/backend/", { owner: "acme", repo: "backend" }],
  ])("reads %j as owner/repo", (raw, expected) => {
    expect(mountHelpers().splitGithubRepo(raw)).toEqual(expected);
  });

  it.each([["backend"], ["acme/"], ["/backend"], ["acme/backend/src"], ["ac me/backend"], [""], [null]])("refuses %j", (raw) => {
    expect(mountHelpers().splitGithubRepo(raw)).toBeNull();
  });
});

describe("jqlScopeWarning", () => {
  const warn = (jql: string, fields: { statusField?: string; repoField?: string } = {}): string | null => mountHelpers().jqlScopeWarning(jql, fields);

  it("names nothing for JQL that only scopes the project", () => {
    expect(warn("project = APP", { statusField: "customfield_10100", repoField: "customfield_10101" })).toBeNull();
  });

  it.each([
    ['project = APP AND "AI-Implement Status" = Ready', {}],
    ["project = APP AND customfield_10100 = Ready", { statusField: "customfield_10100" }],
    ["project = APP AND cf[10100] = Ready", { statusField: "customfield_10100" }],
  ])("warns of a status clause in %j", (jql, fields) => {
    expect(warn(jql, fields)).toMatch(/remove the status clause/i);
  });

  it.each([
    ['project = APP AND "AI-Implement Repo" = "acme/backend"', {}],
    ['project = APP AND cf[10101] = "acme/backend"', { repoField: "customfield_10101" }],
  ])("warns of a repo clause in %j, saying the project does not need one", (jql, fields) => {
    expect(warn(jql, fields)).toMatch(/does not need a repo clause/);
  });

  it("names the status clause first when the JQL has both", () => {
    expect(warn('"AI-Implement Status" = Ready AND "AI-Implement Repo" = "acme/backend"')).toContain("status clause");
  });
});
