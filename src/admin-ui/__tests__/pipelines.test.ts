import { describe, expect, it } from "vitest";
import { pipelinesHtml, pipelinesScript } from "../pages/pipelines.js";

describe("pipelines page", () => {
  it("registers the 'jobs' route and exposes loadLog on window", () => {
    expect(pipelinesScript).toContain("window.registerPage('jobs'");
    expect(pipelinesScript).toContain("window.loadLog = loadLog");
  });

  it("renders 'Needs human' badge for stuck_giveup conclusion", () => {
    expect(pipelinesScript).toContain("stuck_giveup");
    expect(pipelinesScript).toContain("Needs human");
  });

  it("associates stuck_giveup with the fail badge class", () => {
    expect(pipelinesScript).toMatch(/stuck_giveup[\s\S]{0,60}fail/);
  });

  it("ordinary timed_out still maps to warn class", () => {
    expect(pipelinesScript).toContain("timed_out: 'warn'");
  });

  it("jobBadge takes status and conclusion parameters", () => {
    expect(pipelinesScript).toContain("function jobBadge(status, conclusion)");
  });

  it("has no bare api(/esc( calls (must use window.api/window.esc)", () => {
    const stripped = pipelinesScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(pipelinesScript).not.toMatch(/\bvar\s+\w/);
  });

  it("declares the log table elements the script targets", () => {
    expect(pipelinesHtml).toContain('id="log-body"');
    expect(pipelinesHtml).toContain('id="log-empty"');
    expect(pipelinesHtml).toContain('id="log-count"');
  });
});
