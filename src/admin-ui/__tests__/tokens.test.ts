import { describe, expect, it } from "vitest";
import { componentsCss } from "../components.js";
import { adminHtml } from "../index.js";
import { themeJs } from "../theme.js";
import { tokensCss } from "../tokens.js";

describe("tokensCss", () => {
  it("declares :root light theme tokens", () => {
    expect(tokensCss).toMatch(/:root\s*\{[^}]*--bg-app:\s*#fafaf9/);
    expect(tokensCss).toMatch(/--font-sans:\s*['"]Inter['"]/);
    expect(tokensCss).toMatch(/--sp-4:\s*16px/);
  });

  it("declares dark theme overrides via [data-theme='dark']", () => {
    expect(tokensCss).toMatch(/\[data-theme=["']dark["']\]\s*\{[^}]*--bg-app:\s*#0e0f0e/);
    expect(tokensCss).toMatch(/\[data-theme=["']dark["']\]\s*\{[^}]*--accent:\s*#2dd4bf/);
  });

  it("includes accent override for violet (default per design)", () => {
    expect(tokensCss).toMatch(/\[data-accent=["']violet["']\]/);
  });
});

// The colors each block declares, read from the stylesheet so the test follows any edit to it.
function block(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// color-mix(in srgb, a, b p%): b at p percent.
function mix(a: string, b: string, percent: number): string {
  return "#" + channels(a).map((c, i) => Math.round(c * (1 - percent / 100) + channels(b)[i] * (percent / 100)).toString(16).padStart(2, "0")).join("");
}

// WCAG AA for normal text, the size nearly all admin UI text is set at.
const AA = 4.5;

describe("text contrast (WCAG AA) in both themes", () => {
  const accent = /setAttribute\('data-accent', '([a-z]+)'\)/.exec(themeJs)?.[1];
  const shade = /\.setup-check-item\.shaded \{ background: color-mix\(in srgb, var\(--bg-sunken\), var\(--fg-primary\) (\d+)%\)/.exec(componentsCss)?.[1];
  const light = { ...block(":root {"), ...block(`[data-accent="${accent}"] {`) };
  const dark = { ...light, ...block('[data-theme="dark"] {'), ...block(`[data-theme="dark"][data-accent="${accent}"],`) };
  const themes: [string, Record<string, string>][] = [["light", light], ["dark", dark]];

  it("reads the applied accent and the review rows' shade from the page's own code", () => {
    expect(accent).toBeDefined();
    expect(shade).toBeDefined();
  });

  const cases = themes.flatMap(([theme, t]) => {
    const surfaces: Record<string, string> = {
      "bg-app": t["bg-app"],
      "bg-elev": t["bg-elev"],
      "bg-sunken": t["bg-sunken"],
      "bg-hover": t["bg-hover"],
      "a shaded setup-check row": mix(t["bg-sunken"], t["fg-primary"], Number(shade)),
    };
    const onSurfaces = ["fg-primary", "fg-secondary", "fg-tertiary", "accent", "st-success-fg", "st-warn-fg", "st-fail-fg"]
      .flatMap((fg) => Object.entries(surfaces).map(([bg, value]) => [theme, fg, bg, t[fg], value]));
    const pairs = [
      ...["running", "success", "warn", "fail", "neutral", "info"].map((s) => [`st-${s}-fg`, `st-${s}-bg`]),
      ["accent-soft-fg", "accent-soft"],
      ["fg-on-accent", "accent"],
    ].map(([fg, bg]) => [theme, fg, bg, t[fg], t[bg]]);
    return [...onSurfaces, ...pairs];
  });

  it.each(cases)("%s: --%s on %s", (_theme, _fg, _bg, fg, bg) => {
    expect(fg).toMatch(/^#[0-9a-f]{6}$/);
    expect(bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(fg as string, bg as string)).toBeGreaterThanOrEqual(AA);
  });
});

describe("colors on the composed admin page", () => {
  it("reads only custom properties the stylesheets define", () => {
    const defined = new Set([...(tokensCss + componentsCss).matchAll(/(?:^|[\s;{])--([\w-]+):/g)].map((m) => m[1]));
    const read = new Set([...adminHtml.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect([...read].filter((name) => !defined.has(name))).toEqual([]);
  });

  // A hex text color stays the same in both themes, so it cannot be held to either theme's contrast.
  it("sets no text color by hex", () => {
    expect(adminHtml.match(/(?<![\w-])color:\s*#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });
});
