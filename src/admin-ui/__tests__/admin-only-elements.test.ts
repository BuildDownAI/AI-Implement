// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { authJs } from "../auth.js";
import { routerJs } from "../router.js";
import { auditHtml, auditScript } from "../pages/audit.js";
import { sidebarHtml } from "../sidebar.js";

/**
 * The destructive controls on grantable pages are withheld from users by a `window.isAdmin()` guard
 * at each call site. These run the real auth script against a stubbed identity endpoint, because the
 * failure this catches is one of ordering — a guard that reads the role before it has been fetched
 * withholds the control from everyone, which looks identical to an empty table.
 */

const DEDUP_ROW = [{
  issueId: "AII-1",
  issueIdentifier: "AII-1",
  issueTitle: "A dispatched issue",
  dispatchedAt: 1756030000000,
}];

function identity(role: string) {
  return { email: "someone@example.com", name: "Someone", provider: "google", authMethod: "sso", role, grantedPages: ["audit"] };
}

/** Boots the shell the way a browser does: markup, scripts, then DOMContentLoaded. */
async function boot(role: string) {
  document.body.innerHTML = `
    <div id="login-page"></div>
    <div id="admin-page" class="hidden">
      <aside>${sidebarHtml()}</aside>
      <main>${auditHtml}</main>
    </div>`;

  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/api/session-identity") ? identity(role) : DEDUP_ROW),
  })));

  // Same order the page ships them in: auth defines isAdmin, the router defines registerPage.
  new Function(authJs)();
  new Function(routerJs)();
  new Function(auditScript)();
  document.dispatchEvent(new Event("DOMContentLoaded"));
  // Two turns: one for the identity fetch, one for the dedup fetch the page init starts.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("admin-only elements", () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = "#audit";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the dedup Delete button for an admin", async () => {
    await boot("admin");
    expect((window as unknown as { isAdmin(): boolean }).isAdmin()).toBe(true);
    const row = document.querySelector("#dedup-body tr");
    expect(row).not.toBeNull();
    expect(row!.querySelector("button.danger")).not.toBeNull();
  });

  it("withholds it from a user granted the page", async () => {
    await boot("user");
    const row = document.querySelector("#dedup-body tr");
    expect(row).not.toBeNull();
    expect(row!.querySelector("button.danger")).toBeNull();
  });
});
