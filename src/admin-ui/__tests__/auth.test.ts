import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { authJs } from "../auth.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountAuth(): any {
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div id="login-page" class="hidden"></div>
      <div id="admin-page"></div>
      <div id="sso-buttons"></div>
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
  win.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const script = dom.window.document.createElement("script");
  script.textContent = authJs;
  dom.window.document.head.appendChild(script);
  return win;
}

describe("escAttr", () => {
  it("escapes double quotes so they cannot break a quoted attribute", () => {
    const win = mountAuth();
    const dangerous = '" onclick="alert(1)';
    const result: string = win.escAttr(dangerous);
    expect(result).not.toContain('"');
    expect(result).toContain("&quot;");
  });

  it("escapes single quotes", () => {
    const win = mountAuth();
    expect(win.escAttr("it's")).toBe("it&#x27;s");
  });

  it("escapes angle brackets", () => {
    const win = mountAuth();
    expect(win.escAttr("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("escapes ampersands", () => {
    const win = mountAuth();
    expect(win.escAttr("a&b")).toBe("a&amp;b");
  });

  it("handles null and undefined as empty string", () => {
    const win = mountAuth();
    expect(win.escAttr(null)).toBe("");
    expect(win.escAttr(undefined)).toBe("");
  });
});

describe("safeUrl", () => {
  it("blocks javascript: URLs and returns '#'", () => {
    const win = mountAuth();
    expect(win.safeUrl("javascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: regardless of case", () => {
    const win = mountAuth();
    expect(win.safeUrl("JAVASCRIPT:alert(1)")).toBe("#");
  });

  it("blocks data: URLs", () => {
    const win = mountAuth();
    expect(win.safeUrl("data:text/html,<h1>x</h1>")).toBe("#");
  });

  it("passes http: URLs unchanged", () => {
    const win = mountAuth();
    const url = "http://example.com/path?q=1";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes https: URLs unchanged", () => {
    const win = mountAuth();
    const url = "https://github.com/owner/repo/pull/42";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes mailto: URLs unchanged", () => {
    const win = mountAuth();
    const url = "mailto:user@example.com";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes fragment URLs unchanged", () => {
    const win = mountAuth();
    expect(win.safeUrl("#runners")).toBe("#runners");
  });

  it("passes absolute-path URLs unchanged", () => {
    const win = mountAuth();
    expect(win.safeUrl("/api/settings")).toBe("/api/settings");
  });

  it("passes relative URLs unchanged", () => {
    const win = mountAuth();
    expect(win.safeUrl("./page")).toBe("./page");
    expect(win.safeUrl("../up")).toBe("../up");
  });

  it("returns '#' for null", () => {
    const win = mountAuth();
    expect(win.safeUrl(null)).toBe("#");
  });
});

describe("html tagged template", () => {
  it("escapes interpolated values by default", () => {
    const win = mountAuth();
    const result: string = win.html`<div>${"<script>alert(1)</script>"}</div>`;
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("escapes double quotes in interpolations (safe in attribute context)", () => {
    const win = mountAuth();
    const attr = '"evil"';
    const result: string = win.html`<span title="${attr}">x</span>`;
    expect(result).not.toContain('"evil"');
    expect(result).toContain("&quot;evil&quot;");
  });

  it("preserves static template string parts verbatim", () => {
    const win = mountAuth();
    const result: string = win.html`<div class="card">hello</div>`;
    expect(result).toBe('<div class="card">hello</div>');
  });

  it("raw() opt-out passes markup through unescaped", () => {
    const win = mountAuth();
    const markup = '<span class="badge success">OK</span>';
    const result: string = win.html`<div>${win.raw(markup)}</div>`;
    expect(result).toBe(`<div>${markup}</div>`);
  });

  it("mixes escaped and raw values in the same template", () => {
    const win = mountAuth();
    const safe = win.raw('<b>bold</b>');
    const unsafe = '<script>';
    const result: string = win.html`${safe} and ${unsafe}`;
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });
});
