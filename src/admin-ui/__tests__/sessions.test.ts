import { describe, expect, it } from "vitest";
import { sessionsHtml, sessionsScript } from "../pages/sessions.js";

describe("sessions page", () => {
  it("declares the expected ids", () => {
    for (const id of ["lu-sessions", "sessions-body", "sessions-empty"]) {
      expect(sessionsHtml).toContain(`id="${id}"`);
    }
  });
  it("registers the route and exposes loadSessions", () => {
    expect(sessionsScript).toContain("window.registerPage('sessions'");
    expect(sessionsScript).toContain("window.loadSessions = loadSessions");
  });
  it("calls /api/sessions", () => {
    expect(sessionsScript).toContain("/api/sessions");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = sessionsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(sessionsScript).not.toMatch(/\bvar\s+\w/);
  });
  it("links issues through the provider-resolved issueUrl, never a hardcoded tracker host", () => {
    expect(sessionsScript).toContain("window.safeUrl(s.issueUrl)");
    expect(sessionsScript).not.toContain("linear.app");
  });
});
