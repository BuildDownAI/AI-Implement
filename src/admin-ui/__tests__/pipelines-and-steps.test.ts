import { describe, expect, it } from "vitest";
import { pipelinesAndStepsHtml, pipelinesAndStepsScript } from "../pages/pipelines-and-steps.js";
import { inspectPipelinesAndSteps } from "../../inspect-pipeline-graph.js";
import { mountAdminPage, type FakeApiResponse } from "../../__tests__/helpers/fixtures/admin-ui.js";

function mount(answer: FakeApiResponse) {
  return mountAdminPage({ html: pipelinesAndStepsHtml, script: pipelinesAndStepsScript, route: "pipelines", api: async () => answer });
}

describe("pipelines-and-steps page", () => {
  // The route answers inspectPipelinesAndSteps() as it is, so the page is fed the producer's own output.
  it("renders each pipeline and step module the route answers", async () => {
    const answer = inspectPipelinesAndSteps();
    expect(answer.pipelines.length).toBeGreaterThan(0);
    const { win, doc } = mount({ ok: true, status: 200, json: async () => answer });
    await win.loadPipelinesAndSteps();
    expect(doc.querySelectorAll("#ps-pipelines-body details")).toHaveLength(answer.pipelines.length);
    expect(doc.querySelectorAll("#ps-steps-body tr")).toHaveLength(answer.steps.length);
  });

  it("shows a refused load's error as the server wrote it", async () => {
    const { win, doc } = mount({ ok: false, status: 503, json: async () => ({ error: "Access control is unavailable" }) });
    await win.loadPipelinesAndSteps();
    const errorEl = doc.getElementById("ps-error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe("Access control is unavailable");
  });

  it("declares the expected ids", () => {
    for (const id of [
      "ps-subtitle",
      "ps-error",
      "ps-pipelines-body",
      "ps-pipelines-empty",
      "ps-steps-body",
      "ps-steps-empty",
    ]) {
      expect(pipelinesAndStepsHtml).toContain(`id="${id}"`);
    }
  });

  it("registers route + exposes loadPipelinesAndSteps", () => {
    expect(pipelinesAndStepsScript).toContain("window.registerPage('pipelines'");
    expect(pipelinesAndStepsScript).toContain("window.loadPipelinesAndSteps = loadPipelinesAndSteps");
  });

  it("calls /api/pipelines-steps", () => {
    expect(pipelinesAndStepsScript).toContain("/api/pipelines-steps");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = pipelinesAndStepsScript
      .replace(/window\.api\(/g, "")
      .replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(pipelinesAndStepsScript).not.toMatch(/\bvar\s+\w/);
  });
});
