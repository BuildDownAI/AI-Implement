// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { routerJs } from "../router.js";

/** What auth.js's showAdmin() calls once the session identity has resolved. */
function route() {
  (window as unknown as { startRouting(): void }).startRouting();
}

function page(name: string) {
  return document.querySelector(`[data-page="${name}"]`) as HTMLElement;
}

describe("router", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a class="nav-item" data-route="overview"></a>
      <a class="nav-item" data-route="settings"></a>
      <a class="nav-item" data-route="issues"></a>
      <section data-page="overview">A</section>
      <section data-page="settings">B</section>
      <section data-page="issues">C</section>
      <section data-page="no-access">D</section>
    `;
    location.hash = "";
    new Function(routerJs)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });

  // Routing waits for the identity: the role decides which pages exist, and a page's init runs
  // once, so a render before the identity lands could never be corrected.
  it("does not route on DOMContentLoaded alone", () => {
    expect(page("overview").hidden).toBe(false); // untouched: markup ships every section hidden
    expect(page("settings").hidden).toBe(false);
  });

  // Anything that assigns location.hash at load fires this before the identity lands. show() hides
  // every other section, so overview still being visible is what proves nothing routed.
  it("ignores a hashchange that arrives before routing starts", () => {
    location.hash = "#settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(page("overview").hidden).toBe(false);
    route();
    expect(page("settings").hidden).toBe(false);
    expect(page("overview").hidden).toBe(true);
  });

  // The symptom this prevents: an init consumed by an early hashchange never runs again, so the
  // page keeps whatever it rendered against an unknown role.
  it("runs a page init only once routing has started", () => {
    const init = vi.fn();
    (window as unknown as { registerPage(k: string, f: () => void): void }).registerPage("settings", init);
    location.hash = "#settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(init).not.toHaveBeenCalled();
    route();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("defaults to overview when hash is empty", () => {
    route();
    expect(page("overview").hidden).toBe(false);
    expect(page("settings").hidden).toBe(true);
  });

  it("switches when hash changes", () => {
    location.hash = "#settings";
    route();
    expect(page("overview").hidden).toBe(true);
    expect(page("settings").hidden).toBe(false);
    const active = document.querySelector(".nav-item.active") as HTMLElement;
    expect(active.getAttribute("data-route")).toBe("settings");
  });

  it("refuses a hash whose nav item is hidden, as clicking it would have been", () => {
    document.querySelector('[data-route="settings"]')!.setAttribute("hidden", "");
    location.hash = "#settings";
    route();
    expect(page("settings").hidden).toBe(true);
    expect(page("overview").hidden).toBe(false);
  });

  it("falls back to the first visible page when overview is hidden", () => {
    document.querySelector('[data-route="overview"]')!.setAttribute("hidden", "");
    document.querySelector('[data-route="settings"]')!.setAttribute("hidden", "");
    route();
    expect(page("issues").hidden).toBe(false);
    expect(page("overview").hidden).toBe(true);
  });

  it("falls back to no-access when every nav item is hidden", () => {
    document.querySelectorAll(".nav-item").forEach((el) => el.setAttribute("hidden", ""));
    location.hash = "#settings";
    route();
    expect(page("no-access").hidden).toBe(false);
    expect(page("settings").hidden).toBe(true);
  });
});
