import { describe, expect, it } from "vitest";
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
