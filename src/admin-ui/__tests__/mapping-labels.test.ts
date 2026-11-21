// Both project forms name each setting by the label the save's refusals use (MAPPING_FIELD_LABELS, src/admin.ts),
// so a refusal names the setting as the operator sees it, and its `data-field` is what places the refusal beside it.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { MAPPING_FIELD_LABELS, type MappingRefusalField } from "../../admin.js";
import { projectsHtml } from "../pages/projects.js";
import { stepperHtml } from "../stepper.js";

// The Projects page's markup embeds the stepper's, so each form is read inside its own root, as its placement lookup reads it.
const FORMS = [["the Edit dialog", projectsHtml, "#mapping-dialog"], ["the New project stepper", stepperHtml, "#np-stepper-wrap"]] as const;

/** Each labeled setting in a form, with its label's own text: the stepper's "(optional)" note is a span, not the label. */
function labels(html: string, root: string): Array<[string, string]> {
  const doc = new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
  return Array.from(doc.querySelectorAll<HTMLElement>(`${root} .field-label[data-field]`)).map((el) => {
    const own = Array.from(el.childNodes).filter((node) => node.nodeType === node.TEXT_NODE).map((node) => node.textContent ?? "").join("");
    return [el.dataset.field!, own.trim()];
  });
}

describe.each(FORMS)("%s's setting labels", (_form, html, root) => {
  it("shows each setting under the label its refusals use", () => {
    const found = labels(html, root);
    expect(found.length).toBeGreaterThan(20);
    for (const [field, text] of found) {
      expect([field, text]).toEqual([field, MAPPING_FIELD_LABELS[field as MappingRefusalField]]);
    }
  });

  it("marks each setting once, so a refusal has one place to go", () => {
    const fields = labels(html, root).map(([field]) => field);
    expect(fields).toEqual([...new Set(fields)]);
  });
});
