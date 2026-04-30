import { describe, expect, it } from "vitest";
import { customizationsHtml, customizationsScript } from "../pages/customizations.js";

describe("customizations page", () => {
  it("declares the expected ids", () => {
    for (const id of ["customizations-subtitle", "customizations-error", "customizations-root", "customizations-body", "customizations-empty"]) {
      expect(customizationsHtml).toContain(`id="${id}"`);
    }
  });

  it("registers route + exposes loadCustomizations", () => {
    expect(customizationsScript).toContain("window.registerPage('customizations'");
    expect(customizationsScript).toContain("window.loadCustomizations = loadCustomizations");
  });

  it("calls /api/customizations", () => {
    expect(customizationsScript).toContain("/api/customizations");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = customizationsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(customizationsScript).not.toMatch(/\bvar\s+\w/);
  });
});
