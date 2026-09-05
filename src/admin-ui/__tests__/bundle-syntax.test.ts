import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { adminHtml } from "../index.js";
import { themeJs } from "../theme.js";
import { authJs } from "../auth.js";
import { routerJs } from "../router.js";
import { overviewScript } from "../pages/overview.js";
import { settingsScript } from "../pages/settings.js";
import { projectsScript } from "../pages/projects.js";
import { pipelinesScript } from "../pages/pipelines.js";
import { reaperScript } from "../pages/reaper.js";
import { sessionsScript } from "../pages/sessions.js";
import { auditScript } from "../pages/audit.js";
import { issuesScript } from "../pages/issues.js";
import { pullsScript } from "../pages/pulls.js";
import { blockersScript } from "../pages/blockers.js";
import { customizationsScript } from "../pages/customizations.js";
import { pipelinesAndStepsScript } from "../pages/pipelines-and-steps.js";
import { modelsAndProvidersScript } from "../pages/models-and-providers.js";
import { runnersScript } from "../pages/runners.js";
import { reportsScript } from "../pages/reports.js";
import { deploymentsScript } from "../pages/deployments.js";
import { accessScript } from "../pages/access.js";
import { drawerScript } from "../drawer.js";
import { stepperScript } from "../stepper.js";

/**
 * Defence in depth against the 2026-09-05 lockout (AII-535):
 *
 * Layer 1 (this suite, element-level sweep): parse every <script> element that adminHtml
 * actually emits — a syntax error in any element fails here before it reaches prod.
 *
 * Layer 2 (per-module named parse): parse each exported *Script string individually so a
 * failure names the module ("overview") rather than "inline script 3".
 *
 * Layer 3 (poison isolation): verify that a deliberately broken page <script> does NOT
 * prevent the auth/router elements from parsing — the structural property that would have
 * prevented the lockout even if one script slipped through CI.
 *
 * Layer 4 (runtime containment): verify that the pageScript try-catch wrapper catches a
 * runtime throw without propagating, and that the router's registerPage wrapper catches
 * an init-callback throw without propagating to subsequent pages.
 */

// ─── element-level sweep ─────────────────────────────────────────────────────

describe("admin UI inline bundle", () => {
  const scripts = [...adminHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("contains at least one inline script per module (3 infra + 17 pages + 2 shared = 22)", () => {
    // Each module emits its own <script>; merging them back would collapse this count.
    expect(scripts.length).toBeGreaterThanOrEqual(22);
  });

  it("every emitted <script> element parses as valid JavaScript (a syntax error in one element stops only that element)", () => {
    for (const [i, src] of scripts.entries()) {
      expect(() => new vm.Script(src, { filename: `admin-inline-${i}.js` }), `inline script ${i}`).not.toThrow();
    }
  });
});

// ─── per-module named parse ───────────────────────────────────────────────────

describe("per-module script parse", () => {
  const modules: [string, string][] = [
    ["theme", themeJs],
    ["auth", authJs],
    ["router", routerJs],
    ["overview", overviewScript],
    ["settings", settingsScript],
    ["projects", projectsScript],
    ["pipelines", pipelinesScript],
    ["reaper", reaperScript],
    ["sessions", sessionsScript],
    ["audit", auditScript],
    ["issues", issuesScript],
    ["pulls", pullsScript],
    ["blockers", blockersScript],
    ["customizations", customizationsScript],
    ["pipelines-and-steps", pipelinesAndStepsScript],
    ["models-and-providers", modelsAndProvidersScript],
    ["runners", runnersScript],
    ["reports", reportsScript],
    ["deployments", deploymentsScript],
    ["access", accessScript],
    ["drawer", drawerScript],
    ["stepper", stepperScript],
  ];

  it.each(modules)("%s module parses as valid JavaScript", (name, src) => {
    expect(() => new vm.Script(src, { filename: `${name}.js` })).not.toThrow();
  });
});

// ─── poison isolation ─────────────────────────────────────────────────────────

describe("structural isolation", () => {
  it("auth and router scripts still parse when a page script element contains invalid JS", () => {
    // This is the test that would have structurally prevented the 2026-09-05 lockout:
    // with a single <script>, poisoning any content kills everything including login.
    // With per-element isolation, only the poisoned element fails.
    const elements = [...adminHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // Elements: 0=theme, 1=auth, 2=router, 3+=page scripts
    expect(elements.length).toBeGreaterThanOrEqual(4);
    const poisoned = [...elements];
    poisoned[3] = "this is }{{{ not valid JS";
    // The poisoned element fails
    expect(() => new vm.Script(poisoned[3])).toThrow();
    // Infrastructure elements (theme, auth, router) are unaffected
    expect(() => new vm.Script(poisoned[0]), "theme must survive").not.toThrow();
    expect(() => new vm.Script(poisoned[1]), "auth must survive").not.toThrow();
    expect(() => new vm.Script(poisoned[2]), "router must survive").not.toThrow();
  });
});

// ─── runtime containment ──────────────────────────────────────────────────────

describe("runtime error containment", () => {
  it("pageScript-style try-catch wrapper catches a runtime throw and records it in failedPages", () => {
    const failedPages: Record<string, unknown> = {};
    const ctx = vm.createContext({
      window: {
        failedPages,
        markPageFailed: (k: string, e: unknown) => {
          failedPages[k] = e;
        },
      },
      console: { error: () => {} },
    });
    // Simulate pageScript('boom-page', '(function(){ throw new Error("boom"); }())')
    const wrapped = `try{(function(){ throw new Error("boom"); }())}catch(_e){window.markPageFailed&&window.markPageFailed("boom-page",_e);console.error("[admin-ui] page boom-page failed to register",_e);}`;
    expect(() => new vm.Script(wrapped).runInContext(ctx)).not.toThrow();
    // vm sandbox Error !== outer Error; check duck-type instead
    expect(failedPages["boom-page"]).toBeTruthy();
    expect((failedPages["boom-page"] as { message: string }).message).toBe("boom");
  });

  it("a throwing page IIFE does not prevent a later page script from running", () => {
    const failedPages: Record<string, unknown> = {};
    const registered: string[] = [];
    const ctx = vm.createContext({
      window: {
        failedPages,
        markPageFailed: (k: string, e: unknown) => {
          failedPages[k] = e;
        },
        registerPage: (k: string) => {
          registered.push(k);
        },
      },
      console: { error: () => {} },
    });
    const throwing = `try{(function(){ throw new Error("p1 boom"); }())}catch(_e){window.markPageFailed&&window.markPageFailed("p1",_e);}`;
    const working = `try{(function(){ window.registerPage("p2",function(){}); }())}catch(_e){window.markPageFailed&&window.markPageFailed("p2",_e);}`;
    new vm.Script(throwing).runInContext(ctx);
    new vm.Script(working).runInContext(ctx);
    // vm sandbox Error !== outer Error; check duck-type instead
    expect(failedPages["p1"]).toBeTruthy();
    expect((failedPages["p1"] as { message: string }).message).toBe("p1 boom");
    expect(registered).toContain("p2");
  });

  it("a page init that throws when called by the router is contained and does not propagate", () => {
    const ctx = vm.createContext({
      window: { addEventListener: () => {} },
      document: {
        querySelectorAll: (sel: string) => {
          if (sel === ".nav-item:not([hidden])") return [{ getAttribute: () => "throwing-page" }];
          return [];
        },
        querySelector: () => null,
        addEventListener: () => {},
      },
      location: { hash: "#throwing-page" },
      console: { error: () => {} },
    });
    new vm.Script(routerJs).runInContext(ctx);
    // Register a page whose init throws — the router's registerPage wraps it in try-catch
    new vm.Script(`window.registerPage("throwing-page", function(){ throw new Error("init boom"); });`).runInContext(ctx);
    // startRouting triggers show("throwing-page") which calls the wrapped init — must not throw
    expect(() => new vm.Script(`window.startRouting();`).runInContext(ctx)).not.toThrow();
  });
});
