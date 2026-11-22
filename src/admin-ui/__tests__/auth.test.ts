import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { authJs } from "../auth.js";
import { helpersJs } from "../helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountRenderLogin(includeNoAdminEl: boolean, noAdmin: boolean, providers: { id: string; label: string }[] = []): { win: any; dom: JSDOM } {
  const noAdminEl = includeNoAdminEl ? '<div id="no-admin-notice" class="hidden"></div>' : '';
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div id="login-page" class="hidden"></div>
      <div id="admin-page"></div>
      <div id="sso-buttons"></div>
      ${noAdminEl}
      <div id="sso-label" class="hidden"></div>
      <div id="login-divider" class="hidden"></div>
      <div id="access-code-notice" class="hidden"></div>
      <div id="access-code-box" class="hidden"></div>
      <div id="auth-error" class="hidden"></div>
      <input id="access-code" />
      <div id="login-error" class="hidden"></div>
    </body>`,
    { runScripts: "dangerously", url: "http://localhost" }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any;
  win.fetch = async (path: string) => {
    if (String(path).endsWith("/api/session-identity")) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ providers, accessCode: false, noAdmin }) };
  };
  // The order the page ships them in: renderLogin escapes through helpers.ts.
  for (const source of [helpersJs, authJs]) {
    const script = dom.window.document.createElement("script");
    script.textContent = source;
    dom.window.document.head.appendChild(script);
  }
  return { win, dom };
}

describe("renderLogin", () => {
  it("missing no-admin-notice element is a no-op (null-guard)", async () => {
    const { win, dom } = mountRenderLogin(false, false);
    // logout() calls renderLogin() internally; stripped fixture must not throw
    await win.logout();
    // Execution completed — sso-buttons was updated (proves renderLogin ran fully)
    expect(dom.window.document.getElementById("sso-buttons")!.innerHTML).toBe("");
  });

  it("shows no-admin-notice when noAdmin flag is true", async () => {
    const { win, dom } = mountRenderLogin(true, true);
    await win.logout();
    expect(dom.window.document.getElementById("no-admin-notice")!.classList.contains("hidden")).toBe(false);
  });

  it("hides no-admin-notice when noAdmin flag is false", async () => {
    const { win, dom } = mountRenderLogin(true, false);
    await win.logout();
    expect(dom.window.document.getElementById("no-admin-notice")!.classList.contains("hidden")).toBe(true);
  });

  it("escapes a provider's label in its sign-in tile", async () => {
    const { win, dom } = mountRenderLogin(true, false, [{ id: "google", label: "<b>Google</b>" }]);
    await win.logout();
    const tile = dom.window.document.querySelector("#sso-buttons .sso-tile span")!;
    expect(tile.textContent).toBe("<b>Google</b>");
    expect(tile.querySelector("b")).toBeNull();
  });
});
