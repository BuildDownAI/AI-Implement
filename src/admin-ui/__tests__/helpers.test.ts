import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { componentsCss } from "../components.js";
import { helpersJs } from "../helpers.js";
import { blockersScript } from "../pages/blockers.js";
import { deploymentsScript } from "../pages/deployments.js";
import { issuesScript } from "../pages/issues.js";
import { kgPipelinesScript } from "../pages/kg-pipelines.js";
import { overviewScript } from "../pages/overview.js";

/** Runs helpers.ts in a page of its own, as the admin page runs it ahead of every other script. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountHelpers(): any {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { runScripts: "dangerously", url: "http://localhost" });
  const script = dom.window.document.createElement("script");
  script.textContent = helpersJs;
  dom.window.document.head.appendChild(script);
  return dom.window;
}

describe("escAttr", () => {
  it("escapes double quotes so they cannot break a quoted attribute", () => {
    const win = mountHelpers();
    const dangerous = '" onclick="alert(1)';
    const result: string = win.escAttr(dangerous);
    expect(result).not.toContain('"');
    expect(result).toContain("&quot;");
  });

  it("escapes single quotes", () => {
    const win = mountHelpers();
    expect(win.escAttr("it's")).toBe("it&#x27;s");
  });

  it("escapes angle brackets", () => {
    const win = mountHelpers();
    expect(win.escAttr("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("escapes ampersands", () => {
    const win = mountHelpers();
    expect(win.escAttr("a&b")).toBe("a&amp;b");
  });

  it("handles null and undefined as empty string", () => {
    const win = mountHelpers();
    expect(win.escAttr(null)).toBe("");
    expect(win.escAttr(undefined)).toBe("");
  });
});

describe("safeUrl", () => {
  it("blocks javascript: URLs and returns '#'", () => {
    const win = mountHelpers();
    expect(win.safeUrl("javascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: regardless of case", () => {
    const win = mountHelpers();
    expect(win.safeUrl("JAVASCRIPT:alert(1)")).toBe("#");
  });

  it("blocks data: URLs", () => {
    const win = mountHelpers();
    expect(win.safeUrl("data:text/html,<h1>x</h1>")).toBe("#");
  });

  it("passes http: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "http://example.com/path?q=1";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes https: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "https://github.com/owner/repo/pull/42";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes mailto: URLs unchanged", () => {
    const win = mountHelpers();
    const url = "mailto:user@example.com";
    expect(win.safeUrl(url)).toBe(url);
  });

  it("passes fragment URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("#runners")).toBe("#runners");
  });

  it("passes absolute-path URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("/api/settings")).toBe("/api/settings");
  });

  it("passes relative URLs unchanged", () => {
    const win = mountHelpers();
    expect(win.safeUrl("./page")).toBe("./page");
    expect(win.safeUrl("../up")).toBe("../up");
  });

  it("returns '#' for null", () => {
    const win = mountHelpers();
    expect(win.safeUrl(null)).toBe("#");
  });
});

describe("html tagged template", () => {
  it("escapes interpolated values by default", () => {
    const win = mountHelpers();
    const result: string = win.html`<div>${"<script>alert(1)</script>"}</div>`;
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("escapes double quotes in interpolations (safe in attribute context)", () => {
    const win = mountHelpers();
    const attr = '"evil"';
    const result: string = win.html`<span title="${attr}">x</span>`;
    expect(result).not.toContain('"evil"');
    expect(result).toContain("&quot;evil&quot;");
  });

  it("preserves static template string parts verbatim", () => {
    const win = mountHelpers();
    const result: string = win.html`<div class="card">hello</div>`;
    expect(result).toBe('<div class="card">hello</div>');
  });

  it("raw() opt-out passes markup through unescaped", () => {
    const win = mountHelpers();
    const markup = '<span class="badge success">OK</span>';
    const result: string = win.html`<div>${win.raw(markup)}</div>`;
    expect(result).toBe(`<div>${markup}</div>`);
  });

  it("mixes escaped and raw values in the same template", () => {
    const win = mountHelpers();
    const safe = win.raw('<b>bold</b>');
    const unsafe = '<script>';
    const result: string = win.html`${safe} and ${unsafe}`;
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  describe("URL context detection (href/src)", () => {
    it("blocks javascript: in href interpolation", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href="${"javascript:alert(document.cookie)"}">x</a>`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('href="#"');
    });

    it("blocks javascript: in src interpolation", () => {
      const win = mountHelpers();
      const result: string = win.html`<img src="${"javascript:alert(1)"}">`;
      expect(result).not.toContain("javascript:");
      expect(result).toContain('src="#"');
    });

    it("passes https: URL through href unchanged", () => {
      const win = mountHelpers();
      const url = "https://example.com/path";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain(`href="${url}"`);
    });

    it("passes https: URL with query string through href (& encoded per HTML spec)", () => {
      const win = mountHelpers();
      const url = "https://example.com/?a=1&b=2";
      const result: string = win.html`<a href="${url}">link</a>`;
      expect(result).toContain("href=");
      expect(result).not.toContain("javascript:");
      expect(result).toContain("https://example.com/?a=1");
    });

    it("detects href with double-quote delimiter", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href="${"javascript:x"}">x</a>`;
      expect(result).toContain('href="#"');
    });

    it("detects href with spaces around the equals sign", () => {
      const win = mountHelpers();
      const result: string = win.html`<a href = "${"javascript:alert(1)"}">x</a>`;
      expect(result).toBe('<a href = "#">x</a>');
    });

    it("detects href without quote delimiter", () => {
      const win = mountHelpers();
      // href= with no opening quote before the interpolation
      const tmpl = (win as { html: (s: TemplateStringsArray, ...v: unknown[]) => string }).html;
      // Manually exercise via tagged template with no quote
      const strings = Object.assign(["<a href=", ">x</a>"], { raw: ["<a href=", ">x</a>"] }) as unknown as TemplateStringsArray;
      const result: string = tmpl(strings, "javascript:alert(1)");
      expect(result).not.toContain("javascript:");
    });

    it("does not apply safeUrl to non-URL attributes", () => {
      const win = mountHelpers();
      // title= should still just escAttr, not safeUrl (so javascript: string is escaped, not replaced with #)
      const result: string = win.html`<span title="${"javascript:alert(1)"}">x</span>`;
      // escAttr encodes the colon only if needed; javascript: has no chars to escape
      // but it should NOT become '#' — that is safeUrl behaviour, not escAttr behaviour
      expect(result).toContain("javascript:");
      expect(result).not.toContain('title="#"');
    });

    it("raw() still opts out in URL context", () => {
      const win = mountHelpers();
      const markup = win.raw("javascript:alert(1)");
      const result: string = win.html`<a href="${markup}">x</a>`;
      expect(result).toContain("javascript:alert(1)");
    });
  });
});

describe("statusBadge", () => {
  it("puts the dot ahead of the label, so no status badge is written without it", () => {
    const win = mountHelpers();
    expect(win.statusBadge("fail", "Parked")).toBe('<span class="badge fail"><span class="dot"></span>Parked</span>');
  });

  it("escapes the label as text and the kind as an attribute", () => {
    const win = mountHelpers();
    const markup: string = win.statusBadge('warn" onclick="x', "<b>label</b>");
    expect(markup).toContain("&lt;b&gt;label&lt;/b&gt;");
    expect(markup).not.toContain('" onclick');
  });
});

describe("setStatusBadge", () => {
  it("rewrites an element in place, dot included, replacing its earlier kind and label", () => {
    const win = mountHelpers();
    const el = win.document.createElement("span");
    win.setStatusBadge(el, "running", "Building");
    win.setStatusBadge(el, "success", "<Done>");
    expect(el.className).toBe("badge success");
    expect(el.innerHTML).toBe('<span class="dot"></span>&lt;Done&gt;');
  });
});

describe("labelBadge", () => {
  it("writes no dot, so a label never reads as a state", () => {
    const win = mountHelpers();
    expect(win.labelBadge("info", "fly")).toBe('<span class="badge info">fly</span>');
  });

  it("escapes the label as text and the kind as an attribute", () => {
    const win = mountHelpers();
    const markup: string = win.labelBadge('info" onclick="x', "<b>fly</b>");
    expect(markup).toContain("&lt;b&gt;fly&lt;/b&gt;");
    expect(markup).not.toContain('" onclick');
  });
});

describe("fmtAgo", () => {
  const NOW = 1_700_000_000_000;
  const ago = (n: number, unitMs: number) => NOW - n * unitMs;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // The helpers run inside the jsdom window, whose Date is its own, so its clock is the one fixed.
  function mountAt(now: number) {
    const win = mountHelpers();
    win.Date.now = () => now;
    return win;
  }

  it("steps through seconds, minutes and hours", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(ago(45, 1000))).toBe("45s ago");
    expect(win.fmtAgo(ago(12, MIN))).toBe("12m ago");
    expect(win.fmtAgo(ago(5, HOUR))).toBe("5h ago");
    expect(win.fmtAgo(ago(23, HOUR))).toBe("23h ago");
  });

  // A quiet orchestrator's last deploy or run is weeks old,
  // and three weeks read as "504h ago" before this tier existed.
  it("reaches days, so an old event does not read in hundreds of hours", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(ago(24, HOUR))).toBe("1d ago");
    expect(win.fmtAgo(ago(21, DAY))).toBe("21d ago");
    expect(win.fmtAgo(ago(400, DAY))).toBe("400d ago");
  });

  it("takes an ISO string as well as epoch milliseconds", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(new Date(ago(3, HOUR)).toISOString())).toBe("3h ago");
  });

  it("reads a time slightly ahead of this clock as 0s ago rather than a negative count", () => {
    const win = mountAt(NOW);
    expect(win.fmtAgo(NOW + 3000)).toBe("0s ago");
  });
});

describe("fmtDuration", () => {
  const S = 1000;
  const MIN = 60 * S;

  it("reads in seconds under a minute", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(0)).toBe("0s");
    expect(win.fmtDuration(45 * S)).toBe("45s");
    expect(win.fmtDuration(59 * S)).toBe("59s");
  });

  // A counter that ticks every second has to show the seconds move.
  it("keeps the seconds from one minute up to the hour", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(60 * S)).toBe("1m 0s");
    expect(win.fmtDuration(90 * S)).toBe("1m 30s");
    expect(win.fmtDuration(59 * MIN + 59 * S)).toBe("59m 59s");
  });

  it("switches to hours and minutes at exactly one hour", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(60 * MIN)).toBe("1h 0m");
    expect(win.fmtDuration(95 * MIN)).toBe("1h 35m");
  });

  // The start is stamped by whichever process began the work and read by whichever is alive now,
  // so a host whose clock moved backwards must not render "-3s".
  it("clamps a negative length to zero rather than counting down", () => {
    const win = mountHelpers();
    expect(win.fmtDuration(-3 * S)).toBe("0s");
  });
});

// A page joins a list when a change that touches it moves it onto the shared helpers, so the pages
// still missing are what AII-874 (badges) and AII-872 (time formatters) have left to do.
describe("pages on the shared helpers", () => {
  const onSharedBadges: [string, string][] = [
    ["overview", overviewScript],
    ["issues", issuesScript],
    ["blockers", blockersScript],
    ["deployments", deploymentsScript],
    ["kg-pipelines", kgPipelinesScript],
  ];
  const onSharedTime: [string, string][] = [
    ["overview", overviewScript],
    ["deployments", deploymentsScript],
  ];

  it.each(onSharedBadges)("%s writes no badge markup of its own", (_name, script) => {
    expect(script).not.toMatch(/class="badge|className\s*=\s*'badge/);
    expect(script).not.toMatch(/function setBadge\b/);
  });

  // A kind with no stylesheet rule renders a pill with no state color, and nothing else notices.
  // Overview picks its kinds from a status map, so it passes no literal kind to check here.
  const withLiteralKinds = onSharedBadges.filter(([name]) => name !== "overview");
  it.each(withLiteralKinds)("%s passes only badge kinds the stylesheet defines", (_name, script) => {
    const kinds = [...script.matchAll(/(?:setStatusBadge\([^,]+|(?:statusBadge|labelBadge)\()\s*,?\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(componentsCss, kind).toContain(`.badge.${kind} {`);
  });

  it.each(onSharedTime)("%s defines no time formatter of its own", (_name, script) => {
    expect(script).not.toMatch(/function (fmtAgo|fmtDuration|fmtElapsed|fmtRelative)\b/);
  });
});
