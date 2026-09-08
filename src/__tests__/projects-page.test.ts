import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../admin-ui/pages/projects.js";
import { stepperHtml, stepperScript } from "../admin-ui/stepper.js";

/** Tab keys in the order the strip presents them. */
const TABS = ["ticketing", "source", "context", "execution", "capacity", "guardrails", "provider"];

/** The edit dialog alone. The page also carries the stepper, which it owns. */
const dialogHtml = projectsHtml.slice(
  projectsHtml.indexOf('<dialog id="mapping-dialog">'),
  projectsHtml.indexOf("</dialog>"),
);

/**
 * The `.field` wrapper enclosing a control, so a test can assert on a control together with
 * the label and hint that belong to it rather than against the whole document.
 */
function fieldBlockFor(html: string, id: string): string {
  const at = html.indexOf(`id="${id}"`);
  expect(at, `no element carries id="${id}"`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="field"', at);
  const next = html.indexOf('<div class="field"', at);
  return html.slice(start, next === -1 ? start + 1200 : next);
}

describe("mapping dialog — tabbed layout", () => {
  it("declares a panel for every tab and a tab for every panel", () => {
    const tabs = [...projectsHtml.matchAll(/data-md-tab="([a-z]+)"/g)].map((m) => m[1]);
    const panels = [...projectsHtml.matchAll(/data-md-panel="([a-z]+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(TABS);
    expect(panels).toEqual(TABS);
  });

  // Two visible panels would stack two sections; none visible would render an empty dialog.
  // Both fail silently, so the count is worth pinning.
  it("ships exactly one panel visible, and it is the one whose tab is active", () => {
    const panels = [...projectsHtml.matchAll(/data-md-panel="([a-z]+)"( hidden)?/g)];
    expect(panels.filter((m) => !m[2]).map((m) => m[1])).toEqual(["ticketing"]);
    expect(projectsHtml).toContain('class="btn btn-sm active" data-md-tab="ticketing"');
  });

  it("reuses the existing segmented control rather than a new tab component", () => {
    expect(projectsHtml).toContain('<span class="seg" id="md-tabs">');
  });

  // The strip must sit outside .md-body, the scrolling container — inside it, the tabs
  // scroll out of reach exactly when a long panel needs them.
  it("puts the tab strip ahead of the scrolling body", () => {
    expect(projectsHtml.indexOf('id="md-tabs"')).toBeLessThan(projectsHtml.indexOf('class="md-body"'));
  });

  it("exposes the tab switcher and a tab-aware error reporter", () => {
    expect(projectsScript).toContain("window.switchMappingTab = switchMappingTab");
    expect(projectsScript).toContain("function showMappingError(message, tab)");
  });

  // Three save rules span two panels, so the offending field can be on a panel the operator
  // cannot see. Every rejection must name the tab that holds it.
  it("routes every save rejection to a tab", () => {
    const calls = [...projectsScript.matchAll(/showMappingError\('[^;]*?\);/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      expect(call, `no tab argument in ${call}`).toMatch(
        /,\s*'(ticketing|source|context|execution|capacity|guardrails|provider)'\s*\)/,
      );
    }
  });
});

describe("mapping dialog — cap validation", () => {
  it("applies the same rule the server does, and routes the error to the Capacity tab", () => {
    expect(projectsScript).toContain("value !== null && (!Number.isInteger(value) || value < 1)");
    expect(projectsScript).toMatch(/showMappingError\(cap\[0\][^;]*'capacity'\)/);
  });

  // parseInt("1.5") is 1, so a decimal would become a different valid number silently.
  it("parses caps with Number rather than parseInt", () => {
    expect(projectsScript).toContain("v === '' ? null : Number(v)");
    expect(projectsScript).not.toContain("parseInt(v, 10)");
  });
});

describe("mapping dialog — field placement", () => {
  function panelOf(id: string): string | undefined {
    const at = projectsHtml.indexOf(`id="${id}"`);
    return [...projectsHtml.slice(0, at).matchAll(/data-md-panel="([a-z]+)"/g)].pop()?.[1];
  }

  it.each([
    ["md-ticketing-provider", "ticketing"],
    ["md-team-key", "ticketing"],
    ["md-owner", "source"],
    ["md-repo", "source"],
    ["md-branch", "source"],
    ["md-branch-prefix", "source"],
    ["md-skills-repo", "context"],
    ["md-refrepo-repo", "context"],
    ["md-refrepo-path", "context"],
    ["md-refrepo-ref", "context"],
    ["md-dep-token-scope", "context"],
    ["md-exec-mode", "execution"],
    ["md-env", "execution"],
    ["md-max-turns", "capacity"],
    ["md-max-job-min", "capacity"],
    ["md-sensitive-add", "guardrails"],
    ["md-sensitive-allow", "guardrails"],
    ["md-provider", "provider"],
    ["md-planning", "provider"],
  ])("%s sits on the %s panel", (id, panel) => {
    expect(panelOf(id)).toBe(panel);
  });

  // Every field is read by id at save time whether or not its panel is showing, so a
  // duplicated id silently sends the wrong value.
  it("declares no id twice", () => {
    const ids = [...projectsHtml.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("mapping dialog — retired legacy vocabulary", () => {
  it.each([["md-field"], ["md-cols"], ["<fieldset>"], ["<legend>"]])("no longer emits %s", (token) => {
    expect(projectsHtml).not.toContain(token);
  });

  it("titles its sections in sentence case, not the uppercase page-section header", () => {
    expect(projectsHtml).not.toContain('class="section-h"');
    expect(projectsHtml).toContain('<h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Guardrails</h3>');
  });
});

describe("mapping dialog — guardrails", () => {
  it("keeps both glob fields", () => {
    expect(projectsHtml).toContain('id="md-sensitive-add"');
    expect(projectsHtml).toContain('id="md-sensitive-allow"');
  });

  it.each([["md-sensitive-add"], ["md-sensitive-allow"]])(
    "%s carries a non-empty label and a non-empty placeholder",
    (id) => {
      const block = fieldBlockFor(projectsHtml, id);
      expect(block).toMatch(/<label class="field-label">\s*\S[^<]*<\/label>/);
      expect(block).toMatch(new RegExp(`id="${id}"[^>]*placeholder="[^"]+"`));
    },
  );

  it("labels the two fields differently", () => {
    const labelIn = (id: string) => fieldBlockFor(projectsHtml, id).match(/<label class="field-label">([^<]+)</)?.[1];
    expect(labelIn("md-sensitive-add")).not.toBe(labelIn("md-sensitive-allow"));
  });

  it("warns, as an alert, that exceptions override the guardrail", () => {
    expect(projectsHtml).toContain('class="alert warn"');
    expect(projectsHtml).toContain("Exceptions win over every other rule");
  });

  // "glob" is jargon an operator may not carry; the placeholder is what teaches the syntax.
  it("shows worked pattern examples rather than naming the format", () => {
    expect(dialogHtml).toContain("infra/**");
    expect(dialogHtml).not.toContain("one glob per line");
  });

  it("still sends both payload fields", () => {
    expect(projectsScript).toContain("sensitiveAddPatterns");
    expect(projectsScript).toContain("sensitiveAllowPatterns");
  });
});

describe("projects page — owns the surfaces only it opens", () => {
  it("carries the new-project stepper, which nothing else opens", () => {
    expect(projectsHtml).toContain('id="np-stepper-wrap"');
    expect(projectsHtml).toContain('onclick="openNewProjectStepper()"');
  });

  it("mounts the stepper exactly once, inside its own page section", () => {
    expect(projectsHtml.split('id="np-stepper-wrap"').length - 1).toBe(1);
    expect(projectsHtml.indexOf('<section data-page="projects"')).toBeLessThan(
      projectsHtml.indexOf('id="np-stepper-wrap"'),
    );
    expect(projectsHtml.indexOf('id="np-stepper-wrap"')).toBeLessThan(projectsHtml.lastIndexOf("</section>"));
  });
});

/**
 * The page script ships as a string, so its logic cannot be imported. Evaluating it against
 * stub globals reaches the functions it publishes on `window`, which is the only way to test
 * the reference-repository rules as behavior instead of as source text. The escaping helpers
 * are stubbed rather than real — `esc` round-trips through the DOM, and correctness of the
 * helpers themselves belongs to the escaping ADR's own tests, not here.
 */
function loadProjectsGlobals(): Record<string, any> {
  const win: Record<string, any> = {
    registerPage: () => {},
    esc: (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
  };
  const doc = { getElementById: () => null, querySelectorAll: () => [] };
  new Function("window", "document", projectsScript)(win, doc);
  return win;
}

describe("reference repositories — the rules, exercised", () => {
  const win = loadProjectsGlobals();
  const problem = (repo: string, path: string, draft: any[] = [], self = -1) =>
    win.refRepoProblem(repo, path, draft, self);

  it.each([
    ["", "refs/docs", "needs both"],
    ["owner/repo", "", "needs both"],
    ["owner/repo", "/abs/path", "not absolute"],
    ["owner/repo", "C:/win", "not absolute"],
    ["owner/repo", "../escapes", "stay inside"],
    ["owner/repo", "refs/../../out", "stay inside"],
    ["owner/repo", ".git/hooks", ".git"],
    ["owner/repo", "refs\\docs", "forward slashes"],
    ["https://gitlab.com/a/b", "refs/x", "owner/repo or an https://github.com"],
    ["https://user:token@github.com/a/b", "refs/x", "owner/repo or an https://github.com"],
    ["git@github.com:a/b.git", "refs/x", "owner/repo or an https://github.com"],
  ])("rejects %s → %s", (repo, path, fragment) => {
    expect(problem(repo, path)).toContain(fragment);
  });

  it.each([
    ["owner/repo", "refs/docs"],
    ["https://github.com/owner/repo", "vendor/upstream/api"],
    ["owner.name/repo-name", "a/b/c/d"],
  ])("accepts %s → %s", (repo, path) => {
    expect(problem(repo, path)).toBeNull();
  });

  it("rejects a path another entry already holds", () => {
    const draft = [{ repo: "https://github.com/a/b", path: "refs/docs" }];
    expect(problem("owner/repo", "refs/docs", draft)).toContain("already uses the path");
  });

  // Re-checking a stored entry passes its own index; without that it collides with itself
  // and every entry reads as a duplicate.
  it("does not measure an existing entry against itself", () => {
    const draft = [{ repo: "https://github.com/a/b", path: "refs/docs" }];
    expect(problem("a/b", "refs/docs", draft, 0)).toBeNull();
  });

  it("caps new entries at ten, and still validates an existing one at the cap", () => {
    const draft = Array.from({ length: 10 }, (_, i) => ({ repo: "a/b", path: "p" + i }));
    expect(problem("owner/repo", "refs/new", draft)).toContain("Up to ten");
    expect(problem("a/b", "p0", draft, 0)).toBeNull();
  });
});

describe("reference repositories — staging and rendering", () => {
  const win = loadProjectsGlobals();

  it("strips a trailing slash, so a duplicate path cannot slip past the check", () => {
    const draft: any[] = [];
    expect(win.refRepoStage({ repo: "owner/repo", path: "refs/docs/" }, draft)).toBeNull();
    expect(draft[0].path).toBe("refs/docs");
    expect(win.refRepoStage({ repo: "owner/other", path: "refs/docs" }, draft)).toContain("already uses");
  });

  // An absent ref must be omitted rather than stored empty: the server rejects a present-
  // but-empty ref, and the runner reads absence as "the default branch".
  it("omits ref when blank and keeps it when given", () => {
    const draft: any[] = [];
    win.refRepoStage({ repo: "owner/repo", path: "a", ref: "   " }, draft);
    win.refRepoStage({ repo: "owner/repo", path: "b", ref: "testing" }, draft);
    expect(draft[0]).not.toHaveProperty("ref");
    expect(draft[1].ref).toBe("testing");
  });

  it("leaves the draft untouched when the entry is refused", () => {
    const draft: any[] = [];
    expect(win.refRepoStage({ repo: "owner/repo", path: "../out" }, draft)).toBeTruthy();
    expect(draft).toHaveLength(0);
  });

  it("renders owner/repo, an em dash for no ref, and the caller's remove handler", () => {
    const html = win.refRepoRowsHtml(
      [{ repo: "https://github.com/BuildDownAI/docs", path: "refs/docs" }],
      "npRemoveRefRepo",
    );
    expect(html).toContain(">BuildDownAI/docs<");
    expect(html).not.toContain(">https://github.com/BuildDownAI/docs<");
    expect(html).toContain('title="https://github.com/BuildDownAI/docs"');
    expect(html).toContain("&mdash;");
    expect(html).toContain('onclick="npRemoveRefRepo(0)"');
  });

  it("indexes remove by position, so the second row removes the second entry", () => {
    const html = win.refRepoRowsHtml(
      [{ repo: "a/b", path: "p0" }, { repo: "c/d", path: "p1", ref: "main" }],
      "removeRefRepo",
    );
    expect(html).toContain('onclick="removeRefRepo(1)"');
    expect(html).toContain(">main<");
  });

  it("renders nothing at all for an empty draft", () => {
    expect(win.refRepoRowsHtml([], "removeRefRepo")).toBe("");
  });
});

describe("reference repositories — both surfaces", () => {
  // The stepper reaches the rules through these; a missing publish is a TypeError on click
  // that no other gate sees, since one module is a string and the other never imports it.
  it.each([["refRepoRowsHtml"], ["refRepoStage"]])("projects publishes window.%s for the stepper", (fn) => {
    expect(projectsScript).toContain(`window.${fn} = ${fn}`);
    expect(stepperScript).toContain(`window.${fn}(`);
  });

  it("sends the field from the dialog and the stepper alike", () => {
    expect(projectsScript).toContain("referenceRepos: refRepoValue()");
    expect(stepperScript).toContain("referenceRepos: data.referenceRepos.length ? data.referenceRepos : null");
  });

  it("places the field between its two Context neighbours on both surfaces", () => {
    for (const html of [projectsHtml, stepperHtml]) {
      const skills = html.indexOf("skills-repo");
      const refRepo = html.indexOf("refrepo-repo");
      const depScope = html.indexOf("dep-token-scope");
      expect(skills).toBeLessThan(refRepo);
      expect(refRepo).toBeLessThan(depScope);
    }
  });

  // The stepper resets data and inputs from two separate lists, so a field added to one and
  // not the other leaks a previous attempt's text into the next project.
  it("resets the stepper's draft and its add row together", () => {
    expect(stepperScript).toContain("data.referenceRepos = []");
    // Against the reset list itself: these ids appear elsewhere in the script, so asserting
    // on the whole string would pass with the field missing from the reset.
    const toClear = stepperScript.match(/const toClear = \[([^\]]*)\]/)?.[1] ?? "";
    expect(toClear).not.toBe("");
    for (const id of ["np-refrepo-repo", "np-refrepo-path", "np-refrepo-ref"]) {
      expect(toClear).toContain(id);
    }
  });

  it("reviews the count beside the other Context settings", () => {
    expect(stepperHtml).toContain('data-review="referenceRepos"');
    expect(stepperHtml.indexOf('data-review="referenceRepos"')).toBeLessThan(
      stepperHtml.indexOf('data-review="dependencyTokenScope"'),
    );
    expect(stepperScript).toContain("' repository'");
    expect(stepperScript).toContain("' repositories'");
  });
});

describe("new-project stepper — sensitive-files glob fields", () => {
  it("contains both textareas", () => {
    expect(stepperHtml).toContain('id="np-sensitive-add"');
    expect(stepperHtml).toContain('id="np-sensitive-allow"');
  });

  it.each([["np-sensitive-add"], ["np-sensitive-allow"]])("%s carries a non-empty placeholder", (id) => {
    expect(stepperHtml).toMatch(new RegExp(`id="${id}"[^>]*placeholder="[^"]+"`));
  });

  // Both surfaces now carry the same warning, as the same component.
  it("warns, as an alert, that exceptions override the guardrail", () => {
    expect(stepperHtml).toContain('class="alert warn"');
    expect(stepperHtml).toContain("Exceptions win over every other rule");
  });
});
