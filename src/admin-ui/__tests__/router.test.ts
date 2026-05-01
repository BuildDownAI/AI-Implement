// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { routerJs } from "../router.js";

describe("router", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a class="nav-item" data-route="overview"></a>
      <a class="nav-item" data-route="settings"></a>
      <section data-page="overview">A</section>
      <section data-page="settings">B</section>
    `;
    location.hash = "";
    new Function(routerJs)();
    document.dispatchEvent(new Event("DOMContentLoaded"));
  });

  it("defaults to overview when hash is empty", () => {
    const a = document.querySelector('[data-page="overview"]') as HTMLElement;
    const b = document.querySelector('[data-page="settings"]') as HTMLElement;
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(true);
  });

  it("switches when hash changes", () => {
    location.hash = "#settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const a = document.querySelector('[data-page="overview"]') as HTMLElement;
    const b = document.querySelector('[data-page="settings"]') as HTMLElement;
    expect(a.hidden).toBe(true);
    expect(b.hidden).toBe(false);
    const active = document.querySelector(".nav-item.active") as HTMLElement;
    expect(active.getAttribute("data-route")).toBe("settings");
  });
});
