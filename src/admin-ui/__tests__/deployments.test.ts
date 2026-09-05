import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      "deployments-outcome-alert",
      "kpi-deploy-status-badge",
      "kpi-deploy-status",
      "kpi-deploy-status-unit",
      "kpi-deploy-dispatch",
      "deployments-last-outcome",
      "kpi-deploy-outcome-badge",
      "kpi-deploy-outcome-commit",
      "kpi-deploy-outcome-when",
      "kpi-deploy-outcome-meta",
      "deployments-cta",
      "deployments-deploy-btn",
      "deployments-not-configured",
      "deployments-watched-source",
      "deployments-watched-repo",
      "deployments-watched-ref",
      "deployments-check-now-btn",
      "deployments-downgrade-warn",
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
    expect(deploymentsScript).toContain("getElementById('deployments-cta').hidden =");
    expect(deploymentsScript).toContain("!configured || held || (available !== true && !troubled)");
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
      ["success", "Completed"],
      ["warn", "Degraded"],
      ["fail", "Failed"],
    ]) {
      expect(deploymentsScript).toContain(`, '${kind}', '${label}')`);
    }
    // Exactly one writer — the helper itself. A second occurrence means a call site
    // set a badge directly, which is precisely how the dots were lost before.
    const writers = deploymentsScript.match(/className\s*=\s*'badge/g) ?? [];
    expect(writers).toHaveLength(1);
  });

  it("leaves no superseded badge vocabulary behind", () => {
    // A renamed label is added by prepending the new branch and is easy to ship beside the
    // old one: setBadge replaces className and innerHTML outright, so the second block wins
    // and the page looks correct while running both. A toContain assertion cannot see that
    // — it passes on the new labels whether or not the old ones are still there. This
    // shipped once, dead, and was caught in review rather than by the suite.
    for (const gone of ["Deployed OK", "Not serving", "Build failed"]) {
      expect(deploymentsScript).not.toContain(gone);
    }
    // One write per outcome state: the empty state plus the three kinds.
    const outcomeWrites = deploymentsScript.match(/setBadge\(outcomeBadge,/g) ?? [];
    expect(outcomeWrites).toHaveLength(4);
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

  it("states the one-attempt rule on the default hint, not only on the edge case", () => {
    // The already-announced branch implies it; an operator who never hits that branch would
    // otherwise never learn that a failed automatic deploy simply stops. It is the fact that
    // decides whether leaving the switch on is safe, so it belongs on the ordinary reading.
    expect(deploymentsScript).toContain("Once per commit: a push to ");
    expect(deploymentsScript).toContain("A failed deploy is not retried.");
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

  it("pairs availability with the outcome, and gives deploy status its own full-width row", () => {
    // Two columns, and the status tile spans both. Its DOM position is load-bearing: a
    // spanning element placed between the pair would push the outcome onto a half-width
    // row by itself, so status has to come last even though it renders above nothing.
    expect(deploymentsHtml).toContain('id="deployments-kpis" style="grid-template-columns: 1fr 1fr"');
    expect(deploymentsHtml).toContain('id="deployments-status-kpi" hidden style="grid-column: 1 / -1"');
    const at = (id: string) => deploymentsHtml.indexOf(`id="${id}"`);
    expect(at("kpi-deploy-badge")).toBeLessThan(at("deployments-last-outcome"));
    expect(at("deployments-last-outcome")).toBeLessThan(at("deployments-status-kpi"));
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

  it("keeps the outcome tile in the layout before any deploy has happened", () => {
    // The tile is never hidden. It fills from absent to present on the poll right after a
    // deploy completes — the one moment somebody is certainly looking — so a grid that
    // reflows then is worse than an empty tile on a first run. The empty state says so
    // rather than rendering a bare dash with no explanation.
    expect(deploymentsHtml).not.toMatch(/id="deployments-last-outcome"[^>]*\shidden/);
    expect(deploymentsScript).toContain("'None yet'");
    expect(deploymentsScript).toContain("No self-deploy has completed on this orchestrator.");
  });

  it("drives the outcome tile from the outcome alone, never from the hold", () => {
    // An outcome has to survive the hold clearing, which is the entire point of recording
    // it. Scoped to the render block by its real first and last statements — an unanchored
    // slice silently matches nothing once the ids move, and passes for the wrong reason.
    const from = deploymentsScript.indexOf("const outcomeBadge = document.getElementById");
    const to = deploymentsScript.indexOf("const outcomeAlert = document.getElementById");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(deploymentsScript.slice(from, to)).not.toContain("held");
  });

  it("escapes the flyctl detail everywhere it reaches markup", () => {
    // outcome.detail carries flyctl output, and it lands in the alert through innerHTML,
    // so esc() is required — the text-content rule of the three-way escaping convention.
    // Asserting the absence of raw concatenation is the half that catches a regression:
    // adding a second, unescaped write site is the plausible mistake, not removing this one.
    expect(deploymentsScript).toContain("window.esc(outcome.detail)");
    expect(deploymentsScript).not.toMatch(/\+ outcome\.detail/);
    expect(deploymentsScript).not.toMatch(/outcome\.detail \+/);
  });

  it("calls a release with no sidecar degraded, not failed", () => {
    // It released. Every route works except /mcp — the same shape as review_failed in
    // drawer.ts, which is a run that shipped a PR without approval and gets warn, not fail.
    // Red here would have an operator roll back a deployment that is serving traffic.
    expect(deploymentsScript).toContain("setBadge(outcomeBadge, 'warn', 'Degraded')");
    expect(deploymentsScript).not.toContain("'fail', 'Degraded'");
    expect(deploymentsScript).toContain("outcomeAlert.className = 'alert ' + (degraded ? 'warn' : 'fail')");
  });

  it("raises a bad outcome to a page-level alert instead of a tile footnote", () => {
    // A dead knowledge graph is not secondary context, and the trend line is where
    // secondary context lives. Clean outcomes raise nothing.
    expect(deploymentsScript).toContain("outcome.kind !== 'deployed-ok'");
    expect(deploymentsScript).toContain("Released, but the knowledge graph is not serving");
    expect(deploymentsScript).toContain("Deploy did not release");
  });

  it("hides the outcome alert when it cannot be the current story", () => {
    // Two suppressions in one condition. Not configured: the tiles are already hidden, so a
    // leftover alert would be the only thing contradicting the banner. Held: the notice
    // describes the previous deploy while a new one runs, which is the same contradiction
    // the auto hint had when it said "applies from the next push" during a live build.
    expect(deploymentsScript).toContain(
      "const troubled = configured && !held && !!outcome && outcome.kind !== 'deployed-ok';",
    );
  });

  it("reveals the existing deploy control for a bad outcome instead of adding a second one", () => {
    // Availability cannot express this: a degraded release shipped the head commit, so the
    // page reads "up to date" while the running version is the broken one, and gating the
    // control on availability alone hid the only thing that fixes it. Widening that one
    // condition beats a button in the alert — the confirm gate, the disable-in-finally and
    // the caption all already live on the existing control and would need duplicating.
    expect(deploymentsScript).toContain("!configured || held || (available !== true && !troubled)");
    expect(deploymentsScript).not.toContain("alert-actions");

    // Exactly one place in the markup starts a deploy.
    const triggers = deploymentsHtml.match(/triggerDeploy\(\)/g) ?? [];
    expect(triggers).toHaveLength(1);
  });

  it("points the degraded notice at the control that fixes it", () => {
    expect(deploymentsScript).toContain("Deploy now, below, rebuilds and releases the same commit.");
  });

  it("points at the logs rather than storing the flyctl tail", () => {
    // runFlyctl keeps 64 KB of output and console.errors it without attaching it to the
    // Error, so detail stays a single line. That is deliberate: the KG token rides in
    // flyctl's argv, and a stored copy would outlive a rotating log and be served on every
    // status poll. The alert says where the output is instead of reproducing it.
    expect(deploymentsScript).toContain("Full output is in the orchestrator logs.");
  });

  it("marks a failed build's commit as one that never ran", () => {
    // This tile's commit usually equals the running one in the tile beside it. For a build
    // failure it is the commit that was attempted, so the difference has to be stated.
    expect(deploymentsScript).toContain("'attempted — never released'");
  });

  it("calls /api/deployment-status to retrieve lastDeployOutcome", () => {
    // The outcome is a field on the existing endpoint — no second request needed.
    expect(deploymentsScript).toContain("lastDeployOutcome");
  });

  it("posts to /api/deploy-check for the check-now button", () => {
    expect(deploymentsScript).toContain("window.api('/api/deploy-check', { method: 'POST' })");
  });

  it("calls /api/deploy-refs to populate the ref selector", () => {
    expect(deploymentsScript).toContain("/api/deploy-refs?repo=");
  });

  it("reads data.defaultBranch from the deploy-refs response", () => {
    expect(deploymentsScript).toContain("data.defaultBranch");
  });

  it("uses savedPolicy.watchedRef to determine the pinned watched ref", () => {
    expect(deploymentsScript).toContain("savedPolicy.watchedRef");
  });

  it("excludes shown refs from the remaining branches list to avoid duplication", () => {
    expect(deploymentsScript).toContain("shownSet");
  });

  it("filters the Tags optgroup against shownSet so a watched tag is not duplicated", () => {
    expect(deploymentsScript).toContain("data.tags.filter(function(t) { return !shownSet.has(t); })");
    expect(deploymentsScript).toContain("remainingTags.length");
  });

  it("renders Current and Default optgroups for the watched and default refs", () => {
    expect(deploymentsScript).toContain('label="Current"');
    expect(deploymentsScript).toContain('label="Default"');
  });

  it("sets the watched-repo placeholder from the effective watched source", () => {
    expect(deploymentsScript).toContain("watchedRepoEl.placeholder = data.watchedRepo || data.repo || 'owner/repo'");
  });

  it("tracks the stamped branch at module scope and updates it on each status poll", () => {
    expect(deploymentsScript).toContain("let stampedBranch = null");
    expect(deploymentsScript).toContain("stampedBranch = data.branch || null");
  });

  it("renders four optgroups in order: Current, Default, Tags, Branches", () => {
    const idxCurrent = deploymentsScript.indexOf('label="Current"');
    const idxDefault = deploymentsScript.indexOf('label="Default"');
    const idxTags = deploymentsScript.indexOf('label="Tags"');
    const idxBranches = deploymentsScript.indexOf('label="Branches"');
    expect(idxCurrent).toBeGreaterThan(-1);
    expect(idxCurrent).toBeLessThan(idxDefault);
    expect(idxDefault).toBeLessThan(idxTags);
    expect(idxTags).toBeLessThan(idxBranches);
  });

  it("omits the Default group when it equals the Current ref", () => {
    expect(deploymentsScript).toContain("!shownSet.has(defaultBranch)");
  });

  it("derives currentRef from savedPolicy.watchedRef or stampedBranch", () => {
    expect(deploymentsScript).toContain("savedPolicy.watchedRef ? savedPolicy.watchedRef : stampedBranch");
  });

  it("dirty check covers watchedRepo and watchedRef", () => {
    expect(deploymentsScript).toContain("watchedRepoChanged");
    expect(deploymentsScript).toContain("watchedRefChanged");
    expect(deploymentsScript).toContain("savedPolicy.watchedRepo");
    expect(deploymentsScript).toContain("savedPolicy.watchedRef");
  });

  it("seeds savedPolicy with watchedRepo and watchedRef from the status response", () => {
    expect(deploymentsScript).toContain("watchedRepo: data.watchedRepo");
    expect(deploymentsScript).toContain("watchedRef: data.watchedRef");
  });

  it("shows the downgrade warning when data.isDowngrade is strictly true", () => {
    expect(deploymentsScript).toContain("data.isDowngrade !== true");
  });

  it("loads refs when the repo field loses focus", () => {
    expect(deploymentsHtml).toContain('onblur="window.loadDeployRefs()"');
    expect(deploymentsScript).toContain("window.loadDeployRefs = loadDeployRefs");
  });

  it("sends watchedRepo and watchedRef in the policy save patch", () => {
    expect(deploymentsScript).toContain("patch.watchedRepo");
    expect(deploymentsScript).toContain("patch.watchedRef");
  });

  it("uses escAttr on ref and branch values in attribute contexts", () => {
    expect(deploymentsScript).toContain("window.escAttr(b)");
    expect(deploymentsScript).toContain("window.escAttr(t)");
  });

  it("uses esc on ref and branch values in text/innerHTML contexts", () => {
    expect(deploymentsScript).toContain("window.esc(b)");
    expect(deploymentsScript).toContain("window.esc(t)");
  });
});

describe("kg refresh card", () => {
  it("declares the kg-refresh element ids", () => {
    for (const id of ["kg-refresh-card", "kg-refresh-badge", "kg-refresh-stamp", "kg-refresh-last", "kg-refresh-btn"]) {
      expect(deploymentsHtml).toContain(`id="${id}"`);
    }
  });

  it("calls /api/kg/status for status", () => {
    expect(deploymentsScript).toContain("/api/kg/status");
  });

  it("exposes triggerKgRefresh", () => {
    expect(deploymentsScript).toContain("window.triggerKgRefresh");
  });

  it("posts to /api/kg/refresh for the refresh trigger", () => {
    expect(deploymentsScript).toContain("window.api('/api/kg/refresh', { method: 'POST' })");
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
      expect(deploymentsScript).toContain(`, '${kind}', '${label}')`);
    }
  });

  it("emits stage-specific progress text for each in-progress stage", () => {
    expect(deploymentsScript).toContain("Checking KG source repo for a newer snapshot");
    expect(deploymentsScript).toContain("Runner job dispatched");
    expect(deploymentsScript).toContain("waiting for snapshot commit");
    expect(deploymentsScript).toContain("Snapshot commit confirmed");
    expect(deploymentsScript).toContain("starting local staging");
    expect(deploymentsScript).toContain("Staging new graph overlay");
  });

  it("falls back to running:true for older responses without a stage field", () => {
    // Older orchestrators omit stage; the UI must not crash or show an empty badge.
    expect(deploymentsScript).toContain("data.stage || (data.running ? 'checking' : 'idle')");
  });

  it("disables the refresh button while running or deploy-held", () => {
    expect(deploymentsScript).toContain("!!data.running || !!data.deployHeld");
  });

  it("shows the 422 callback-unconfigured message as a warning, not an error", () => {
    // The 422 is an expected configuration gap, not a server fault.
    expect(deploymentsScript).toContain("res.status === 422 && body.precondition === 'callback-unconfigured'");
    expect(deploymentsScript).toContain("RUNNER_CALLBACK_BASE_URL");
    expect(deploymentsScript).toContain("RUNNER_TOKEN_SECRET");
  });

  it("shows a 409 deploy-held warning distinct from refresh-in-progress", () => {
    expect(deploymentsScript).toContain("body.error === 'deploy-in-progress'");
    expect(deploymentsScript).toContain("A deploy is in progress");
    expect(deploymentsScript).toContain("A refresh is already in progress.");
  });
});

describe("fmtElapsed", () => {
  // The page ships as one concatenated script string, so its helpers are only reachable
  // by extraction. Worth the reach here: the interesting behaviour is the 60s and 60m
  // boundaries, and a toContain assertion cannot see which side of one the code lands on.
  const source = deploymentsScript.match(/function fmtElapsed\(startedAt\) \{[\s\S]*?\n  \}/);
  if (!source) throw new Error("fmtElapsed not found in deploymentsScript");
  const fmtElapsed = new Function(`return (${source[0]});`)() as (startedAt: number) => string;

  const NOW = 1_700_000_000_000;
  const secondsAgo = (n: number) => NOW - n * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads in seconds under a minute", () => {
    expect(fmtElapsed(secondsAgo(0))).toBe("0s");
    expect(fmtElapsed(secondsAgo(45))).toBe("45s");
    expect(fmtElapsed(secondsAgo(59))).toBe("59s");
  });

  it("switches to whole minutes at exactly one minute", () => {
    expect(fmtElapsed(secondsAgo(60))).toBe("1m");
    expect(fmtElapsed(secondsAgo(90))).toBe("1m");
    expect(fmtElapsed(secondsAgo(59 * 60))).toBe("59m");
  });

  it("switches to hours and minutes at exactly one hour", () => {
    expect(fmtElapsed(secondsAgo(60 * 60))).toBe("1h 0m");
    expect(fmtElapsed(secondsAgo(95 * 60))).toBe("1h 35m");
  });

  it("clamps a start in the future to zero rather than counting down", () => {
    // The stamp is written by whichever process claimed the hold, and read by whichever
    // is alive now. A host whose clock moved backwards must not render "-3s elapsed".
    expect(fmtElapsed(NOW + 3000)).toBe("0s");
  });
});

describe("deploy status tile", () => {
  it("reads the start time the status endpoint reports", () => {
    expect(deploymentsScript).toContain("data.deployStartedAt");
    expect(deploymentsScript).toContain("fmtElapsed(data.deployStartedAt) + ' elapsed'");
  });

  it("puts the activity in the value and elapsed in the unit, matching Draining", () => {
    // Draining already puts its live counts in the value slot. Building previously read
    // "All in-flight work drained" there — a completed fact where the other phase shows a
    // live one — with the activity demoted to the unit. Swapping makes the two consistent
    // and frees the unit for the number that says the deploy is still moving.
    expect(deploymentsScript).toContain("statusEl.textContent = 'Building and releasing the new image';");
    expect(deploymentsScript).toContain("statusUnit.textContent = elapsed;");
    expect(deploymentsScript).not.toContain("All in-flight work drained");
  });

  it("falls back to the old Draining wording when no start time exists", () => {
    // A hold claimed by a process that predates the clock, or set by hand, still renders
    // something rather than an empty unit.
    expect(deploymentsScript).toContain("statusUnit.textContent = elapsed || 'waiting for in-flight work to finish';");
  });

  it("labels kg-refresh in-flight work as 'KG ingest run' rather than the raw kind key", () => {
    // The draining tile maps w.kind === 'kg-refresh' to a human-readable label so operators
    // can distinguish a KG ingest drain from a runner-job drain at a glance (AII-518).
    expect(deploymentsScript).toContain("w.kind === 'kg-refresh'");
    expect(deploymentsScript).toContain("plural(w.count, 'KG ingest run')");
  });

  it("uses fmtAgo for past events and fmtElapsed for the running one", () => {
    // fmtAgo bakes "ago" into its output, which is wrong for a duration still accruing.
    expect(deploymentsScript).toContain("'checked ' + fmtAgo(data.checkedAt)");
    expect(deploymentsScript).toContain("fmtAgo(outcome.timestamp)");
    const elapsedCalls = deploymentsScript.match(/fmtElapsed\(/g) ?? [];
    expect(elapsedCalls).toHaveLength(2); // the declaration and its single call site
  });
});

describe("fmtAgo", () => {
  const source = deploymentsScript.match(/function fmtAgo\(ms\) \{[\s\S]*?\n  \}/);
  if (!source) throw new Error("fmtAgo not found in deploymentsScript");
  const fmtAgo = new Function(`return (${source[0]});`)() as (ms: number) => string;

  const NOW = 1_700_000_000_000;
  const ago = (n: number, unitMs: number) => NOW - n * unitMs;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("steps through seconds, minutes and hours", () => {
    expect(fmtAgo(ago(45, 1000))).toBe("45s ago");
    expect(fmtAgo(ago(12, MIN))).toBe("12m ago");
    expect(fmtAgo(ago(5, HOUR))).toBe("5h ago");
    expect(fmtAgo(ago(23, HOUR))).toBe("23h ago");
  });

  // The availability check runs every poll, so it never leaves seconds. The last deploy of a
  // quiet orchestrator is weeks old, and hours do not survive that: three weeks read as
  // "504h ago" before this tier existed.
  it("reaches days, so an old deploy does not read in hundreds of hours", () => {
    expect(fmtAgo(ago(24, HOUR))).toBe("1d ago");
    expect(fmtAgo(ago(21, DAY))).toBe("21d ago");
    expect(fmtAgo(ago(400, DAY))).toBe("400d ago");
  });
});
