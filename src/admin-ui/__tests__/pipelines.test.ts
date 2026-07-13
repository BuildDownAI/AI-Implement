import { describe, expect, it } from "vitest";
import { pipelinesHtml, pipelinesScript } from "../pages/pipelines.js";

describe("pipelines page time filter", () => {
  it("renders the Time Filter controls (relative + absolute range)", () => {
    expect(pipelinesHtml).toContain("Time Filter");
    expect(pipelinesHtml).toContain('id="log-time-type"');
    expect(pipelinesHtml).toContain('id="log-rel-n"');
    expect(pipelinesHtml).toContain('id="log-rel-unit"');
    expect(pipelinesHtml).toContain('id="log-range-start"');
    expect(pipelinesHtml).toContain('id="log-range-end"');
  });

  it("defaults the relative filter to last 7 days", () => {
    expect(pipelinesHtml).toContain('value="7"');
    expect(pipelinesHtml).toContain('<option value="d" selected>');
  });

  it("appends the time filter to the /api/log request", () => {
    expect(pipelinesScript).toContain("'/api/log' + getTimeFilter()");
    expect(pipelinesScript).toMatch(/'\?since=' \+ \(Date\.now\(\)/);
  });

  it("appends the filter label to the job count and range-aware empty state", () => {
    expect(pipelinesScript).toContain("' · ' + getFilterLabel()");
    expect(pipelinesScript).toContain("No jobs in the selected time range");
  });

  it("pauses auto-refresh while an absolute range is selected", () => {
    expect(pipelinesScript).toContain("function startLogAutoRefresh");
    expect(pipelinesScript).toContain("function stopLogAutoRefresh");
    expect(pipelinesScript).toContain(
      "if (isRange) { stopLogAutoRefresh(); } else { startLogAutoRefresh(); }",
    );
    // registerPage uses the managed auto-refresh, not a bare setInterval
    expect(pipelinesScript).toMatch(/registerPage\('jobs',[\s\S]*startLogAutoRefresh\(\);/);
  });
});
