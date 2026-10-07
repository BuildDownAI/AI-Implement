import { describe, expect, it } from "vitest";
import { kgPipelinesHtml, kgPipelinesScript } from "../pages/kg-pipelines.js";
import { deploymentsHtml, deploymentsScript } from "../pages/deployments.js";

describe("kg pipelines page", () => {
  it("is a hidden data-page section with its own message box", () => {
    expect(kgPipelinesHtml).toContain('<section data-page="kg-pipelines" hidden>');
    expect(kgPipelinesHtml).toContain('<div id="kg-pipelines-error" hidden></div>');
    expect(kgPipelinesHtml).toContain("Knowledge Graph Pipelines");
  });

  it("carries every card id, and Deployments carries none", () => {
    for (const id of ["kg-refresh-card", "kg-refresh-badge", "kg-refresh-stamp", "kg-refresh-last", "kg-sidecar-status", "kg-refresh-btn", "kg-dry-run-btn", "kg-accept-baseline-btn", "kg-dry-run-last", "kg-materialize-controls", "btn-kg-materialize-rdflib", "btn-kg-materialize-direct", "kg-materialize-source"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
      expect(deploymentsHtml).not.toContain(id);
    }
  });

  it("showMessage writes into #kg-pipelines-error, never #deployments-error", () => {
    expect(kgPipelinesScript).toContain("document.getElementById('kg-pipelines-error')");
    expect(kgPipelinesScript).not.toContain("deployments-error");
  });

  it("setBadge keeps the dot span", () => {
    expect(kgPipelinesScript).toContain('<span class="dot"></span>');
  });

  it("registers the page with both 15s pollers", () => {
    expect(kgPipelinesScript).toContain("setInterval(loadKgStatus, 15000)");
    expect(kgPipelinesScript).toContain("window.registerPage('kg-pipelines'");
  });

  it("leaves no KG card code on Deployments but keeps the deploy-side KG text", () => {
    expect(deploymentsScript).not.toContain("loadKgStatus");
    expect(deploymentsScript).not.toContain("loadKgMaterializeMode");
    expect(deploymentsScript).not.toContain("/api/kg/");
    expect(deploymentsScript).toContain("setInterval(loadDeployments, 30000)");
    expect(deploymentsScript).toContain("plural(w.count, 'KG ingest run')");
  });
});

describe("kg refresh card", () => {
  it("declares the kg-refresh element ids", () => {
    for (const id of ["kg-refresh-card", "kg-refresh-badge", "kg-refresh-stamp", "kg-refresh-last", "kg-refresh-btn", "kg-sidecar-status"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
  });

  it("renders the sidecar liveness state beside the stage badge and hides it before the first probe (AII-650)", () => {
    // The element ships hidden; the script shows the warning with the probe's lastError when the
    // sidecar is unavailable, a one-line "reachable" when a probe has run, and hides it otherwise.
    expect(kgPipelinesHtml).toContain('id="kg-sidecar-status" hidden');
    expect(kgPipelinesScript).toContain("const sidecarEl = document.getElementById('kg-sidecar-status')");
    expect(kgPipelinesScript).toContain("if (data.kgUnavailable) {");
    expect(kgPipelinesScript).toContain("'⚠️ KG sidecar not serving — ' + ((data.sidecar && data.sidecar.lastError) || 'unknown error')");
    expect(kgPipelinesScript).toContain("} else if (data.sidecar && data.sidecar.checkedAt) {");
    expect(kgPipelinesScript).toContain("sidecarEl.textContent = 'KG sidecar: reachable'");
    expect(kgPipelinesScript).toContain("sidecarEl.hidden = true");
  });

  it("calls /api/kg/status for status", () => {
    expect(kgPipelinesScript).toContain("/api/kg/status");
  });

  it("exposes triggerKgRefresh", () => {
    expect(kgPipelinesScript).toContain("window.triggerKgRefresh");
  });

  it("declares the dry-run element ids (AII-635)", () => {
    for (const id of ["kg-dry-run-btn", "kg-dry-run-last"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
    expect(kgPipelinesHtml).toContain('onclick="window.triggerKgRefresh(true)"');
  });

  it("posts { dryRun: true } for the dry-run trigger and renders the part table (AII-635)", () => {
    expect(kgPipelinesScript).toContain("window.api('/api/kg/refresh', { method: 'POST', body: JSON.stringify({ dryRun: true }) })");
    expect(kgPipelinesScript).toContain("function renderKgDryRun(");
    expect(kgPipelinesScript).toContain("['part', 'previous', 'new', 'delta']");
    expect(kgPipelinesScript).toContain("document.getElementById('kg-dry-run-btn').disabled = busy");
  });

  it("declares the accept-baseline button and gates it behind confirm() (AII-628)", () => {
    expect(kgPipelinesHtml).toContain('id="kg-accept-baseline-btn"');
    expect(kgPipelinesHtml).toContain('onclick="window.triggerKgAcceptBaseline()"');
    expect(kgPipelinesScript).toContain("window.triggerKgAcceptBaseline = ");
    expect(kgPipelinesScript).toContain("if (!confirm(");
    expect(kgPipelinesScript).toContain("JSON.stringify({ acceptNewBaseline: true })");
    expect(kgPipelinesScript).toContain("document.getElementById('kg-accept-baseline-btn').disabled = busy");
    // All three buttons share one refusal-to-message mapping and disable each other while a request is in flight.
    expect(kgPipelinesScript).toContain("function showKgRefreshRefusal(res, body)");
    expect((kgPipelinesScript.match(/showKgRefreshRefusal\(res, await/g) || []).length).toBe(2);
  });

  it("posts to /api/kg/refresh for the refresh trigger", () => {
    expect(kgPipelinesScript).toContain("window.api('/api/kg/refresh', { method: 'POST' })");
  });

  it("maps every stage to a badge via setBadge", () => {
    // Each new stage must pass through setBadge — a textContent write drops the dot span.
    for (const [kind, label] of [
      ["running", "checking"],
      ["running", "running"],   // ingest-running
      ["running", "landing"],   // snapshot-landed
      ["running", "staging"],
      ["ok", "serving"],
      ["warn", "reverted"],
      ["fail", "failed"],
      ["warn", "degraded"],     // kgDegraded fallback
      ["neutral", "stale"],     // ingest-needed fallback
    ] as const) {
      expect(kgPipelinesScript).toContain(`, '${kind}', '${label}')`);
    }
  });

  it("emits stage-specific progress text for each in-progress stage", () => {
    expect(kgPipelinesScript).toContain("Checking KG source repo for a newer snapshot");
    expect(kgPipelinesScript).toContain("Runner job dispatched");
    expect(kgPipelinesScript).toContain("waiting for snapshot commit");
    expect(kgPipelinesScript).toContain("Snapshot commit confirmed");
    expect(kgPipelinesScript).toContain("starting local staging");
    expect(kgPipelinesScript).toContain("Staging new graph overlay");
  });

  it("falls back to running:true for older responses without a stage field", () => {
    // Older orchestrators omit stage; the UI must not crash or show an empty badge.
    expect(kgPipelinesScript).toContain("data.stage || (data.running ? 'checking' : 'idle')");
  });

  it("disables the refresh button while running or deploy-held", () => {
    expect(kgPipelinesScript).toContain("!!data.running || !!data.deployHeld");
  });

  it("shows the 422 callback-unconfigured message as a warning, not an error", () => {
    // The 422 is an expected configuration gap, not a server fault.
    expect(kgPipelinesScript).toContain("res.status === 422 && body.precondition === 'callback-unconfigured'");
    expect(kgPipelinesScript).toContain("RUNNER_CALLBACK_BASE_URL");
    expect(kgPipelinesScript).toContain("RUNNER_TOKEN_SECRET");
  });

  it("shows a 409 deploy-held warning distinct from refresh-in-progress", () => {
    expect(kgPipelinesScript).toContain("body.error === 'deploy-in-progress'");
    expect(kgPipelinesScript).toContain("A deploy is in progress");
    expect(kgPipelinesScript).toContain("A refresh is already in progress.");
  });
});

describe("kg materialize-mode control (AII-602)", () => {
  it("declares the materialize control element ids", () => {
    for (const id of [
      "kg-materialize-controls",
      "btn-kg-materialize-rdflib",
      "btn-kg-materialize-direct",
      "kg-materialize-source",
    ]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
    }
  });

  it("fetches /api/kg/materialize-mode for the current mode", () => {
    expect(kgPipelinesScript).toContain("/api/kg/materialize-mode");
  });

  it("posts direct: true/false to /api/kg/materialize-mode when toggled", () => {
    expect(kgPipelinesScript).toContain("window.setKgMaterializeDirect");
    expect(kgPipelinesScript).toContain("{ method: 'POST', body: JSON.stringify({ direct: direct }) }");
  });

  it("wires the rdflib and direct buttons to setKgMaterializeDirect with the right argument", () => {
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgMaterializeDirect(false)\"");
    expect(kgPipelinesHtml).toContain("onclick=\"window.setKgMaterializeDirect(true)\"");
  });

  it("has no env-pinned warning or disabled handling (AII-1109)", () => {
    expect(kgPipelinesHtml).not.toContain("kg-materialize-env-warning");
    expect(kgPipelinesScript).not.toContain("kg-materialize-env-warning");
    expect(kgPipelinesScript).not.toContain("envPinned");
  });

  it("registers loadKgMaterializeMode on page load and on a poll interval", () => {
    expect(kgPipelinesScript).toContain("loadKgMaterializeMode();");
    expect(kgPipelinesScript).toContain("setInterval(loadKgMaterializeMode, 15000)");
  });

  it("renders the runs table after the refresh card, filtered to kg-refresh", () => {
    for (const id of ["kglog-body", "kglog-time-type", "kglog-count", "kglog-empty"]) {
      expect(kgPipelinesHtml).toContain(`id="${id}"`);
      expect(kgPipelinesHtml.indexOf(`id="${id}"`)).toBeGreaterThan(kgPipelinesHtml.indexOf('id="kg-refresh-card"'));
    }
    expect(kgPipelinesScript).toContain("if (window.createDispatchLog) window.createDispatchLog('kglog'");
    expect(kgPipelinesScript).toContain("e.phase === 'kg-refresh'");
  });
});
