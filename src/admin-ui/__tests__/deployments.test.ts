import { describe, expect, it } from "vitest";
import { deploymentsHtml, deploymentsScript } from "../pages/deployments.js";

describe("deployments page", () => {
  it("declares the expected ids", () => {
    for (const id of [
      "deployments-error",
      "deployments-kpis",
      "kpi-deploy-badge",
      "kpi-deploy-commit",
      "kpi-deploy-checked",
      "kpi-deploy-source",
      "deployments-status-kpi",
      "kpi-deploy-status-badge",
      "kpi-deploy-status",
      "kpi-deploy-status-unit",
      "kpi-deploy-dispatch",
      "deployments-cta",
      "deployments-deploy-btn",
      "deployments-not-configured",
    ]) {
      expect(deploymentsHtml).toContain(`id="${id}"`);
    }
  });

  it("registers route + exposes loadDeployments", () => {
    expect(deploymentsScript).toContain("window.registerPage('deployments'");
    expect(deploymentsScript).toContain("window.loadDeployments = loadDeployments");
  });

  it("exposes triggerDeploy", () => {
    expect(deploymentsScript).toContain("window.triggerDeploy = triggerDeploy");
  });

  it("calls /api/deployment-status", () => {
    expect(deploymentsScript).toContain("/api/deployment-status");
  });

  it("posts to /api/deploy for the deploy trigger", () => {
    // Asserting the bare path would pass on /api/deployment-status alone, which
    // contains it as a substring — the method is what identifies the trigger.
    expect(deploymentsScript).toContain("window.api('/api/deploy', { method: 'POST' })");
  });

  it("compares availability strictly, so unknown never renders as up to date", () => {
    // The regression this guards is a falsy collapse: `!available` makes null
    // indistinguishable from false and shows "Up to date" for an unknown commit.
    expect(deploymentsScript).toContain("available === true");
    expect(deploymentsScript).toContain("available === false");
    expect(deploymentsScript).not.toMatch(/\(\s*!available\s*\)/);
  });

  it("hides the tiles and the deploy control when self-deploy is unconfigured", () => {
    // Availability and status both describe an action this orchestrator cannot take,
    // so the not-configured banner is the whole page.
    expect(deploymentsScript).toContain("getElementById('deployments-kpis').hidden = !configured");
    expect(deploymentsScript).toContain(
      "getElementById('deployments-cta').hidden = !configured || held || available !== true",
    );
  });

  it("shows the deploy-status tile only while a deploy holds", () => {
    // It has nothing to say otherwise, and a tile that appears and disappears as a
    // second column reads worse than one that owns its own row.
    expect(deploymentsScript).toContain("statusKpi.hidden = !held");
  });

  it("states the dispatch pause once, not per phase", () => {
    // The pause belongs to deploying rather than to draining or building, so the
    // wording is set outside the phase branches. Two copies would drift apart and
    // imply the pause itself differs between phases.
    const matches = deploymentsScript.match(/New dispatches are paused until the deploy completes/g);
    expect(matches).toHaveLength(1);
  });

  it("pluralises the in-flight work kinds", () => {
    // "2 runner-job" was the reading before this; the count and the noun have to agree.
    expect(deploymentsScript).toContain("(count === 1 ? '' : 's')");
    expect(deploymentsScript).toContain("plural(w.count, w.kind)");
  });

  it("confirms before triggering a deploy, and does so before the request", () => {
    // Native confirm is the house gate for consequential actions (destroying a machine,
    // deleting a secret). Ordering is the point: confirming after the POST would gate
    // nothing, and the deploy pauses every dispatch surface the moment it starts.
    const gate = deploymentsScript.indexOf("!confirm('Deploy now?");
    const post = deploymentsScript.indexOf("window.api('/api/deploy'");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(post);
  });

  it("re-enables the deploy button in a finally, not on one branch", () => {
    // The original returned early on success and left the button permanently dead
    // whenever a fast failure cleared the hold before the next poll could hide it.
    const finallyAt = deploymentsScript.indexOf("} finally {");
    const reEnable = deploymentsScript.indexOf("btn.disabled = false");
    expect(finallyAt).toBeGreaterThan(-1);
    expect(reEnable).toBeGreaterThan(finallyAt);
  });

  it("builds commit links with escAttr on the path segments", () => {
    // The scheme is static, so escAttr is the right guard and safeUrl would be
    // validating a scheme we wrote ourselves. Escaping matters because these segments
    // land inside a quoted attribute, where esc() does not escape quotes.
    expect(deploymentsScript).toContain('href="https://github.com/\' + window.escAttr(repo)');
    expect(deploymentsScript).toContain("window.escAttr(sha)");
  });

  it("renders every badge through setBadge, so none loses its dot", () => {
    // `.badge` alone is a dotless pill — the dot is a child span that `.badge .dot`
    // sizes and `.badge.running .dot` animates. Writing a badge with textContent drops
    // it silently: the pill still reads correctly, so nothing looks broken. Asserting
    // the helper is the only writer is what makes the omission impossible rather than
    // merely unlikely.
    expect(deploymentsScript).toContain('<span class="dot"></span>');
    for (const [kind, label] of [
      ["warn", "Draining"],
      ["running", "Building"],
      ["warn", "Available"],
      ["success", "Up to date"],
      ["neutral", "Unknown"],
    ]) {
      expect(deploymentsScript).toContain(`, '${kind}', '${label}')`);
    }
    // Exactly one writer — the helper itself. A second occurrence means a call site
    // set a badge directly, which is precisely how the dots were lost before.
    const writers = deploymentsScript.match(/className\s*=\s*'badge/g) ?? [];
    expect(writers).toHaveLength(1);
  });

  it("keeps the commit links at value size rather than using .mono", () => {
    // .mono sets font-size: 11.5px alongside the family and wins the cascade against
    // .kpi-value, which clamped 28px links down to 11.5px.
    expect(deploymentsScript).not.toMatch(/class="[^"]*\bmono\b[^"]*"/);
    expect(deploymentsScript).toContain("font-family: var(--font-mono)");
  });

  it("keeps Refresh as the only header action, with the deploy control below the tile", () => {
    // Every other page ends its header with Refresh. Scoped to the element on purpose:
    // an unscoped match reaches the deploy button further down the document and passes
    // no matter where the button actually lives.
    const headerActions =
      deploymentsHtml.match(/<div class="page-header-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(headerActions).toContain("Refresh");
    expect(headerActions).not.toContain("deployments-deploy-btn");

    const cta = deploymentsHtml.match(/id="deployments-cta"([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
    expect(cta).toContain("deployments-deploy-btn");
  });

  it("declares the policy card ids", () => {
    for (const id of [
      "deployments-policy",
      "deployments-auto",
      "deployments-notify",
      "deployments-auto-hint",
      "deployments-notify-hint",
    ]) {
      expect(deploymentsHtml).toContain(`id="${id}"`);
    }
  });

  it("groups both switches under one question, using the settings card pattern", () => {
    // They are two answers to "what happens when a deployment becomes available", not
    // independent preferences — the framing is what stops them reading as unrelated.
    expect(deploymentsHtml).toContain('class="card" id="deployments-policy"');
    expect(deploymentsHtml).toContain("When a deployment becomes available");
    expect(deploymentsHtml).toContain('class="checkbox-row"');
  });

  it("hides the policy card when self-deploy is unconfigured", () => {
    expect(deploymentsScript).toContain("getElementById('deployments-policy').hidden = !configured");
  });

  it("saves both flags through the policy endpoint", () => {
    expect(deploymentsScript).toContain("window.api('/api/deploy-policy', { method: 'POST'");
    expect(deploymentsScript).toContain("window.saveDeployPolicy = saveDeployPolicy");
  });

  it("re-renders from the server after saving rather than trusting the checkbox", () => {
    // The flags interact, so an optimistic update can show a hint that is not yet true.
    const save = deploymentsScript.slice(deploymentsScript.indexOf("async function saveDeployPolicy"));
    expect(save.slice(0, save.indexOf("\n  }"))).toContain("loadDeployments()");
  });

  it("explains the combination that does nothing", () => {
    // Automatic deploying makes the announcement inert. Two switches that look
    // independent while one silences the other is the confusion worth pre-empting.
    expect(deploymentsScript).toContain("No effect while automatic deploying is on");
    // Names the way to enable it rather than only reporting that it is off — an
    // unavailable capability the operator cannot discover is worse than a dead switch.
    expect(deploymentsScript).toContain("NOTIFY_WEBHOOK_URL");
  });

  it("does not claim a deploy is deferred while that deploy is running", () => {
    // Observed live: the status tile read "Building" while the hint said the commit
    // "applies from the next push". Both true in isolation, contradictory side by side.
    expect(deploymentsScript).toContain("if (held) return 'On — the deploy in progress above is the current one.';");
    expect(deploymentsScript).toContain("autoHint(data, available, held)");
  });

  it("offers the manual path when automatic deploying cannot act on the waiting commit", () => {
    // One attempt per commit means enabling the toggle does not reach back for a commit
    // already announced. Saying so, and naming the button, is the whole point.
    expect(deploymentsScript).toContain("applies from the next push");
    expect(deploymentsScript).toContain("Deploy now to release it immediately");
  });

  it("declares every id exactly once", () => {
    // The page is one concatenated string, so a duplicated block is easy to introduce
    // and silent: getElementById returns the first match, leaving the copy rendered but
    // permanently stale. A toContain assertion cannot see it — a count can.
    const ids = [...deploymentsHtml.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("orders the body: tiles, then the policy, then the deploy control", () => {
    const at = (id: string) => deploymentsHtml.indexOf(`id="${id}"`);
    expect(at("deployments-kpis")).toBeLessThan(at("deployments-policy"));
    expect(at("deployments-policy")).toBeLessThan(at("deployments-cta"));
  });

  it("saves on submit rather than on every click", () => {
    // Writing per click makes an accidental tick a live config change, and gives the
    // 30s poll a window to clobber a half-made decision.
    expect(deploymentsHtml).toContain('id="deployments-policy-save"');
    expect(deploymentsHtml).toContain('onchange="window.refreshPolicyDirty()"');
    expect(deploymentsHtml).not.toContain('onchange="window.saveDeployPolicy()"');
  });

  it("does not overwrite unsaved checkboxes on a poll", () => {
    expect(deploymentsScript).toContain("if (!policyDirty()) {");
  });

  it("disables the announcement switch when no webhook exists", () => {
    expect(deploymentsScript).toContain("notifyEl.disabled = !data.notifyConfigured");
  });

  it("keeps an unavailable announcement switch out of the form entirely", () => {
    // Forced unchecked so a greyed-but-ticked box cannot claim something is being sent,
    // excluded from the dirty check so Save is not lit forever against a stored true,
    // and omitted from the patch so saving cannot overwrite the stored preference.
    expect(deploymentsScript).toContain("if (!data.notifyConfigured) notifyEl.checked = false;");
    expect(deploymentsScript).toContain("!notifyEl.disabled && notifyEl.checked !== savedPolicy.notifyAvailable");
    expect(deploymentsScript).toContain("if (!notifyEl.disabled) patch.notifyAvailable = notifyEl.checked;");
  });

  it("keeps the page subtitle static", () => {
    // A state-dependent subtitle duplicates the Availability tile. Dynamic subtitles
    // are this codebase's collection-count convention (issues, pulls, runners); this
    // page describes one object, so it follows sessions/reaper/reports instead.
    expect(deploymentsHtml).toContain('class="page-subtitle"');
    expect(deploymentsScript).not.toContain("subtitle");
  });

  it("uses the window-scoped helpers, not bare globals", () => {
    const stripped = deploymentsScript
      .replace(/window\.api\(/g, "")
      .replace(/window\.escAttr\(/g, "")
      .replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
    expect(stripped).not.toMatch(/\bescAttr\(/);
  });

  it("uses const/let, not var", () => {
    expect(deploymentsScript).not.toMatch(/\bvar\s+\w/);
  });

  it("updates the nav indicator based on availability", () => {
    expect(deploymentsScript).toContain("deploy-available");
    expect(deploymentsScript).toContain("navCount.hidden");
  });
});
