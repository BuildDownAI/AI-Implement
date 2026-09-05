import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../admin-ui/pages/projects.js";
import { stepperHtml } from "../admin-ui/stepper.js";

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
