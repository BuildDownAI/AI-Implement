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
      <div id="no-admin-notice" class="hidden"></div>
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountRenderLogin(includeNoAdminEl: boolean, noAdmin: boolean): { win: any; dom: JSDOM } {
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
    return { ok: true, status: 200, json: async () => ({ providers: [], accessCode: false, noAdmin }) };
  };
  const script = dom.window.document.createElement("script");
  script.textContent = authJs;
  dom.window.document.head.appendChild(script);
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

  describe("URL context detection (href/src)", () => {
    it("blocks javascript: in href interpolation", () => {
      const win = mountAuth();
      const result: string = win.html`<a href="${"javascript:alert(document.cookie)"}">x</a>`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('href="#"');
    });

    it("blocks javascript: in src interpolation", () => {
      const win = mountAuth();
      const result: string = win.html`<img src="${"javascript:alert(1)"}">`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('src="#"');
    });

    it("passes https: URL through href unchanged", () => {
      const win = mountAuth();
      const url = "https://example.com/path";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain(`href="${url}"`);
    });

    it("passes https: URL with query string through href (& encoded per HTML spec)", () => {
      const win = mountAuth();
      const url = "https://example.com/?a=1&b=2";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain("href=");
      expect(result).not.toContain("javascript:");
      expect(result).toContain("https://example.com/?a=1");
    });

    it("detects href with double-quote delimiter", () => {
      const win = mountAuth();
      const result: string = win.html`<a href="${"javascript:x"}">x</a>`;
      expect(result).toContain('href="#"');
    });

    it("detects href without quote delimiter", () => {
      const win = mountAuth();
      // href= with no opening quote before the interpolation
      const tmpl = (win as { html: (s: TemplateStringsArray, ...v: unknown[]) => string }).html;
      // Manually exercise via tagged template with no quote
      const strings = Object.assign(["<a href=", ">x</a>"], { raw: ["<a href=", ">x</a>"] }) as unknown as TemplateStringsArray;
      const result: string = tmpl(strings, "javascript:alert(1)");
      expect(result).not.toContain("javascript:");
    });

    it("does not apply safeUrl to non-URL attributes", () => {
      const win = mountAuth();
      // title= should still just escAttr, not safeUrl (so javascript: string is escaped, not replaced with #)
      const result: string = win.html`<span title="${"javascript:alert(1)"}">x</span>`;
      // escAttr encodes the colon only if needed; javascript: has no chars to escape
      // but it should NOT become '#' — that is safeUrl behaviour, not escAttr behaviour
      expect(result).toContain("javascript:");
      expect(result).not.toContain('title="#"');
    });

    it("raw() still opts out in URL context", () => {
      const win = mountAuth();
      const markup = win.raw("javascript:alert(1)");
      const result: string = win.html`<a href="${markup}">x</a>`;
      expect(result).toContain("javascript:alert(1)");
    });
  });
});
