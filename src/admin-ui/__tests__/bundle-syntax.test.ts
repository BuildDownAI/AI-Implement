import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { adminHtml } from "../index.js";

/**
 * Every page's client script is a TypeScript string template concatenated into one inline
 * <script> at module load. tsc never parses the contents of those strings, so a syntax error
 * inside one — a stray quote, an unescaped backtick, a template-literal escape consumed one
 * level too early — ships silently and kills the ENTIRE bundle in the browser, including the
 * login page. Observed live 2026-09-05: `this.closest(\'dialog\')` inside a template literal
 * reached the browser as `'dialog'` inside a single-quoted string; every admin user was
 * locked out with no SSO tile and a dead access-code form. This test parses the served
 * bundle exactly as a browser would, so that class of defect fails here instead of in prod.
 */
describe("admin UI inline bundle", () => {
  const scripts = [...adminHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("contains at least one inline script", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("parses as valid JavaScript (a syntax error anywhere kills the whole admin UI)", () => {
    for (const [i, src] of scripts.entries()) {
      expect(() => new vm.Script(src, { filename: `admin-inline-${i}.js` }), `inline script ${i}`).not.toThrow();
    }
  });
});
