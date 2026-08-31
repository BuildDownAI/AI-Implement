// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { accessHtml, accessScript } from "../pages/access.js";

/**
 * The add-entry modal stages rows before committing them to the page's pending list. The path worth
 * pinning is the single-entry one: filling the field and pressing the commit button without first
 * pressing the stage button, which is what most people will do and what keeps one entry to one
 * click. Nothing but commitStagedEntries() staging the typed value makes that work.
 */
function boot() {
  document.body.innerHTML = accessHtml;
  // The page script needs only these two from the shared script block; the rest of its API calls
  // hang off the page-init callback, which never fires here.
  (window as unknown as { esc: (s: unknown) => string }).esc = (s) => String(s ?? "");
  (window as unknown as { registerPage: () => void }).registerPage = () => {};
  new Function(accessScript)();
}

const win = window as unknown as Record<string, () => void>;
const field = () => document.getElementById("access-new-value") as HTMLInputElement;
const rows = () => document.getElementById("access-body")!.textContent ?? "";
const modalOpen = () => !document.getElementById("add-entry-modal")!.hidden;

describe("add-entry modal", () => {
  beforeEach(boot);

  it("commits a typed value that was never staged, so one entry costs one click", () => {
    win.openAddEntry();
    field().value = "ada@eudoxus.ai";
    win.commitStagedEntries();

    expect(rows()).toContain("ada@eudoxus.ai");
    expect(modalOpen()).toBe(false);
  });

  it("commits staged rows together with a value still sitting in the field", () => {
    win.openAddEntry();
    field().value = "one@eudoxus.ai";
    win.stageAccessEntry();
    field().value = "two@eudoxus.ai";
    win.commitStagedEntries();

    expect(rows()).toContain("one@eudoxus.ai");
    expect(rows()).toContain("two@eudoxus.ai");
  });

  it("refuses an invalid typed value and holds the modal open rather than dropping it", () => {
    win.openAddEntry();
    field().value = "not-an-email";
    win.commitStagedEntries();

    expect(rows()).not.toContain("not-an-email");
    expect(modalOpen()).toBe(true);
    expect(document.getElementById("access-error")!.textContent).toContain("not an email address");
  });

  it("discards staged rows when the modal is reopened, so cancelling means cancelled", () => {
    win.openAddEntry();
    field().value = "gone@eudoxus.ai";
    win.stageAccessEntry();
    win.closeAddEntry();
    win.openAddEntry();
    win.commitStagedEntries();

    expect(rows()).not.toContain("gone@eudoxus.ai");
  });
});
