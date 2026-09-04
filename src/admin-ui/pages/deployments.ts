export const deploymentsHtml = `
<section data-page="deployments" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Deployments</h1>
      <div class="page-subtitle">Release a new version of this orchestrator — dispatch pauses until in-flight work drains</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadDeployments()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="deployments-error" hidden></div>

    <div class="kpi-grid" id="deployments-kpis" style="grid-template-columns: 1fr 1fr">
      <div class="kpi">
        <div class="kpi-label">Availability <span class="badge neutral" id="kpi-deploy-badge">—</span></div>
        <div class="kpi-value"><span id="kpi-deploy-commit">—</span><span class="kpi-unit" id="kpi-deploy-checked"></span></div>
        <div class="kpi-trend" id="kpi-deploy-source"></div>
      </div>
      <div class="kpi" id="deployments-last-outcome">
        <div class="kpi-label">Last deploy <span class="badge neutral" id="kpi-deploy-outcome-badge">—</span></div>
        <div class="kpi-value"><span id="kpi-deploy-outcome-commit">—</span><span class="kpi-unit" id="kpi-deploy-outcome-when"></span></div>
        <div class="kpi-trend" id="kpi-deploy-outcome-meta"></div>
      </div>
      <div class="kpi" id="deployments-status-kpi" hidden style="grid-column: 1 / -1">
        <div class="kpi-label">Deploy status <span class="badge neutral" id="kpi-deploy-status-badge">—</span></div>
        <div class="kpi-value"><span id="kpi-deploy-status">—</span><span class="kpi-unit" id="kpi-deploy-status-unit"></span></div>
        <div class="kpi-trend" id="kpi-deploy-dispatch"></div>
      </div>
    </div>

    <div id="deployments-watched-source" class="card" hidden style="margin-top: 16px">
      <div class="card-body" style="padding: 12px 16px">
        <div class="kpi-label" style="margin-bottom: 4px">Watching</div>
        <div id="deployments-watched-source-value" style="font-size: 14px; font-family: var(--font-mono)">—</div>
        <div id="deployments-downgrade-warn" class="kpi-trend" style="color: var(--color-warn); margin-top: 4px" hidden>
          ⚠ This ref is behind the running commit — deploying it is a downgrade.
        </div>
        <div style="margin-top: 8px">
          <button class="btn btn-sm" id="deployments-check-now-btn" onclick="window.checkNow()">Check now</button>
        </div>
      </div>
    </div>

    <div class="alert" id="deployments-outcome-alert" hidden></div>

    <div class="card" id="deployments-policy" hidden>
      <div class="card-header"><h2 class="card-title">When a deployment becomes available...</h2></div>
      <div class="card-body">
        <div style="margin-bottom: 16px">
          <div class="kpi-label" style="margin-bottom: 6px">Watched source</div>
          <div style="display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap">
            <div style="flex: 1; min-width: 200px">
              <input type="text" class="input" id="deployments-watched-repo" placeholder="owner/repo"
                style="width: 100%; box-sizing: border-box"
                oninput="window.refreshPolicyDirty()"
                onblur="window.loadDeployRefs()">
              <div class="kpi-trend text-secondary" style="margin-top: 4px">Leave blank to use the build stamp</div>
            </div>
            <div style="flex: 1; min-width: 160px">
              <select class="input" id="deployments-watched-ref" style="width: 100%; box-sizing: border-box"
                onchange="window.refreshPolicyDirty()">
                <option value="">— select a ref —</option>
              </select>
              <div class="kpi-trend text-secondary" style="margin-top: 4px" id="deployments-ref-hint"></div>
            </div>
          </div>
        </div>

        <label class="checkbox-row">
          <input type="checkbox" id="deployments-auto" onchange="window.refreshPolicyDirty()">
          <span>Deploy it automatically</span>
        </label>
        <div class="kpi-trend text-secondary" id="deployments-auto-hint" style="margin-left: 24px"></div>

        <label class="checkbox-row" id="deployments-notify-row">
          <input type="checkbox" id="deployments-notify" onchange="window.refreshPolicyDirty()">
          <span>Announce it to the notification webhook</span>
        </label>
        <div class="kpi-trend text-secondary" id="deployments-notify-hint" style="margin-left: 24px"></div>

        <div style="margin-top: 12px">
          <button class="btn btn-primary btn-sm" id="deployments-policy-save" onclick="window.saveDeployPolicy()" disabled>Save</button>
        </div>
      </div>
    </div>

    <div id="deployments-cta" hidden style="text-align: center">
      <div style="display: inline-flex; flex-direction: column; align-items: center; gap: 8px">
        <button class="btn btn-accent btn-lg" id="deployments-deploy-btn" onclick="window.triggerDeploy()">Deploy now</button>
        <div class="kpi-trend text-secondary" style="justify-content: center; max-width: 46ch">New dispatches pause immediately, and in-flight work drains before the build starts.</div>
      </div>
    </div>

    <div class="card" id="kg-refresh-card" hidden>
      <div class="card-header"><h2 class="card-title">Knowledge graph <span class="badge neutral" id="kg-refresh-badge">—</span></h2></div>
      <div class="card-body">
        <div class="kpi-trend" id="kg-refresh-stamp">Served graph stamp: —</div>
        <div class="kpi-trend text-secondary" id="kg-refresh-last"></div>
        <div style="margin-top: 12px">
          <button class="btn btn-sm" id="kg-refresh-btn" onclick="window.triggerKgRefresh()">Refresh graph now</button>
          <span class="kpi-trend text-secondary" style="margin-left: 8px">Fetches the KG source repo's committed snapshot and restarts the sidecar — no deploy, no dispatch pause.</span>
        </div>
      </div>
    </div>

    <div id="deployments-not-configured" class="alert warn" hidden>
      <div style="flex:1">
        <div class="alert-title">Self-deploy not configured</div>
        <div class="alert-desc">This orchestrator cannot deploy itself. Set <span class="mono">FLY_DEPLOY_TOKEN</span> and ensure the image was built with the <span class="mono">AI_IMPLEMENT_SOURCE_*</span> build args stamped in.</div>
      </div>
    </div>
  </div>
</section>
`;

export const deploymentsScript = `
(function () {
  function fmtAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    // The last deploy of a quiet orchestrator is weeks old, and "504h ago" is unreadable.
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  // Duration since a start, not distance from now — deliberately not fmtAgo, whose
  // "Xm ago" wording reads wrong for something still running.
  function fmtElapsed(startedAt) {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function short(sha) { return sha ? sha.slice(0, 7) : ''; }

  function plural(count, noun) {
    return count + '\\u00a0' + noun + (count === 1 ? '' : 's');
  }

  // Every badge in the app carries a .dot child: .badge .dot sizes it, .badge.<kind> .dot
  // colours it, and .badge.running .dot is where the pulse animation lives. The class
  // alone renders a dotless pill, so the span is opt-in markup that is easy to drop.
  // Routing every badge through here is what stops that recurring on this page.
  function setBadge(el, kind, label) {
    el.className = 'badge ' + kind;
    el.innerHTML = '<span class="dot"></span>' + window.esc(label);
  }

  // a static https:// prefix with escAttr on the path segments
  function commitLink(repo, sha) {
    if (!repo || !sha) return '';
    // .mono sets font-size: 11.5px as well as the family, and wins the cascade against
    // .kpi-value — so the family is set here directly to keep the SHAs at value size.
    return '<a class="text-accent" style="font-family: var(--font-mono)" href="https://github.com/' + window.escAttr(repo)
      + '/commit/' + window.escAttr(sha) + '" target="_blank">' + window.esc(short(sha)) + '</a>';
  }

  // One box, two severities: reading status can fail transiently while the page stays
  // usable, but a refused deploy is a real failure. .warning/.error are the house pair.
  function showMessage(kind, text) {
    const el = document.getElementById('deployments-error');
    el.className = kind;
    el.textContent = text;
    el.hidden = false;
  }

  function clearMessage() {
    document.getElementById('deployments-error').hidden = true;
  }

  function autoHint(data, available, held) {
    if (!data.autoDeploy) {
      return 'Off — an available deployment is announced instead, and you decide when to release it.';
    }
    // A deploy in flight already has its own tile saying what is happening. Repeating
    // "applies from the next push" beside it reads as a contradiction, because the
    // commit being deployed is the one the per-commit guard has just consumed.
    if (held) return 'On — the deploy in progress above is the current one.';
    // One attempt per commit, so switching this on does not reach back for a commit
    // already announced. Name it, and name the way out.
    if (available === true && data.headCommit && data.headCommit === data.lastActedCommit) {
      return short(data.headCommit) + ' is available now but was already announced, so this applies from the next push. Use Deploy now to release it immediately.';
    }
    // The one-attempt rule is the load-bearing fact about this switch and appeared nowhere:
    // the already-announced branch above implies it, and an operator who never hits that
    // branch would not learn that a failed automatic deploy simply stops.
    return 'Once per commit: a push to ' + (data.branch || 'the watched branch')
      + ' pauses dispatch and releases without asking. A failed deploy is not retried.';
  }

  function notifyHint(data) {
    if (!data.notifyConfigured) return 'Unavailable — set NOTIFY_WEBHOOK_URL on the orchestrator to announce available deployments here.';
    if (data.autoDeploy) return 'No effect while automatic deploying is on — the restart notice already announces the pause.';
    return 'Sent once per commit, to the same webhook as run notifications.';
  }

  // What the server last told us. Kept so an edit can be detected, and so the 30s poll
  // does not silently revert a checkbox someone has ticked but not yet saved.
  let savedPolicy = null;
  let stampedBranch = null;

  function policyDirty() {
    if (!savedPolicy) return false;
    // A disabled announcement switch is not part of the form: it is forced unchecked
    // while no webhook exists, which would otherwise read as permanently dirty against
    // a stored true and leave Save lit forever.
    const notifyEl = document.getElementById('deployments-notify');
    const notifyChanged = !notifyEl.disabled && notifyEl.checked !== savedPolicy.notifyAvailable;
    const watchedRepoChanged = document.getElementById('deployments-watched-repo').value !== (savedPolicy.watchedRepo || '');
    const watchedRefChanged = document.getElementById('deployments-watched-ref').value !== (savedPolicy.watchedRef || '');
    return document.getElementById('deployments-auto').checked !== savedPolicy.autoDeploy || notifyChanged || watchedRepoChanged || watchedRefChanged;
  }

  function refreshPolicyDirty() {
    document.getElementById('deployments-policy-save').disabled = !policyDirty();
  }

  async function loadDeployRefs() {
    const repo = document.getElementById('deployments-watched-repo').value.trim();
    const refSel = document.getElementById('deployments-watched-ref');
    const hintEl = document.getElementById('deployments-ref-hint');
    if (!repo) {
      refSel.innerHTML = '<option value="">— select a ref —</option>';
      hintEl.textContent = '';
      return;
    }
    hintEl.textContent = 'Loading refs…';
    try {
      const res = await window.api('/api/deploy-refs?repo=' + encodeURIComponent(repo));
      if (!res.ok) {
        const body = await res.json().catch(function () { return {}; });
        hintEl.textContent = body.error || 'Could not load refs';
        return;
      }
      const data = await res.json();
      const prev = refSel.value;
      const defaultBranch = data.defaultBranch || null;
      const currentRef = savedPolicy && savedPolicy.watchedRef ? savedPolicy.watchedRef : stampedBranch;
      const shownSet = new Set();

      let html = '<option value="">— select a ref —</option>';
      if (currentRef) {
        shownSet.add(currentRef);
        html += '<optgroup label="Current">';
        html += '<option value="' + window.escAttr(currentRef) + '">' + window.esc(currentRef) + '</option>';
        html += '</optgroup>';
      }
      if (defaultBranch && !shownSet.has(defaultBranch)) {
        shownSet.add(defaultBranch);
        html += '<optgroup label="Default">';
        html += '<option value="' + window.escAttr(defaultBranch) + '">' + window.esc(defaultBranch) + '</option>';
        html += '</optgroup>';
      }
      if (data.tags && data.tags.length) {
        const remainingTags = data.tags.filter(function(t) { return !shownSet.has(t); });
        if (remainingTags.length) {
          html += '<optgroup label="Tags">';
          for (const t of remainingTags) html += '<option value="' + window.escAttr(t) + '">' + window.esc(t) + '</option>';
          html += '</optgroup>';
        }
      }
      if (data.branches && data.branches.length) {
        const remaining = data.branches.filter(function(b) { return !shownSet.has(b); }).sort();
        if (remaining.length) {
          html += '<optgroup label="Branches">';
          for (const b of remaining) html += '<option value="' + window.escAttr(b) + '">' + window.esc(b) + '</option>';
          html += '</optgroup>';
        }
      }
      refSel.innerHTML = html;
      // Restore previous selection if it still exists in the new list
      if (prev) refSel.value = prev;
      hintEl.textContent = '';
    } catch (err) {
      hintEl.textContent = 'Failed to load refs — ' + String(err);
    }
    refreshPolicyDirty();
  }

  async function loadDeployments() {
    clearMessage();

    let data;
    try {
      const res = await window.api('/api/deployment-status');
      if (!res.ok) {
        let message = 'Unknown error';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        showMessage('warning', 'Could not read deployment status — ' + message);
        return;
      }
      data = await res.json();
    } catch (err) {
      showMessage('warning', 'Could not read deployment status — ' + String(err));
      return;
    }

    const configured = !!data.configured;
    const available = data.available;
    const held = !!data.held;
    const inFlight = Array.isArray(data.inFlight) ? data.inFlight : [];

    // With self-deploy off the banner is the whole page — availability and status
    // describe an action this orchestrator cannot take.
    document.getElementById('deployments-not-configured').hidden = configured;
    document.getElementById('deployments-kpis').hidden = !configured;

    // A bad outcome is its own reason to deploy, and availability cannot express it: a
    // degraded release shipped the head commit, so availability reads "up to date" while the
    // running version is the broken one. Gating on availability alone hid the single control
    // that fixes what the page was warning about.
    const outcome = data.lastDeployOutcome;
    const troubled = configured && !held && !!outcome && outcome.kind !== 'deployed-ok';
    document.getElementById('deployments-cta').hidden =
      !configured || held || (available !== true && !troubled);

    // The policy card follows the tiles: meaningless on an orchestrator that cannot
    // deploy itself, where the banner below is the whole story.
    document.getElementById('deployments-policy').hidden = !configured;

    // Watched-source field: always visible when configured; shows resolved repo + ref.
    const watchedSourceCard = document.getElementById('deployments-watched-source');
    watchedSourceCard.hidden = !configured;
    if (configured) {
      const sourceRepo = data.repo || '';
      const sourceBranch = data.branch || '';
      const sourceText = [sourceRepo, sourceBranch].filter(Boolean).join(' · ') || '(not configured)';
      document.getElementById('deployments-watched-source-value').textContent = sourceText;
      document.getElementById('deployments-downgrade-warn').hidden = data.isDowngrade !== true;
    }

    const autoEl = document.getElementById('deployments-auto');
    const notifyEl = document.getElementById('deployments-notify');
    const watchedRepoEl = document.getElementById('deployments-watched-repo');
    const watchedRefEl = document.getElementById('deployments-watched-ref');

    // Computed against the *previous* server state, before it is replaced below — the
    // poll must not overwrite a checkbox that is ticked and not yet saved.
    if (!policyDirty()) {
      autoEl.checked = !!data.autoDeploy;
      notifyEl.checked = !!data.notifyAvailable;
      watchedRepoEl.value = data.watchedRepo || '';
      // Seed the ref selector with the saved value; the options are loaded on blur.
      const savedRef = data.watchedRef || '';
      if (watchedRefEl.value !== savedRef) {
        // Add a placeholder option for the saved ref if it is not already in the list
        const existing = watchedRefEl.querySelector('option[value="' + CSS.escape(savedRef) + '"]');
        if (savedRef && !existing) {
          const opt = document.createElement('option');
          opt.value = savedRef;
          opt.textContent = savedRef;
          watchedRefEl.appendChild(opt);
        }
        watchedRefEl.value = savedRef;
      }
    }
    watchedRepoEl.placeholder = data.watchedRepo || data.repo || 'owner/repo';
    stampedBranch = data.branch || null;
    savedPolicy = {
      autoDeploy: !!data.autoDeploy,
      notifyAvailable: !!data.notifyAvailable,
      watchedRepo: data.watchedRepo || '',
      watchedRef: data.watchedRef || '',
    };
    refreshPolicyDirty();

    // Nothing can be announced without somewhere to announce to, so the control says so
    // by being unavailable rather than by being a switch that quietly does nothing.
    // Unchecked as well as disabled: the stored value may be true, but nothing is being
    // announced, and a ticked-but-greyed box claims otherwise. The stored value is never
    // written from here, so it returns intact once a webhook exists.
    notifyEl.disabled = !data.notifyConfigured;
    if (!data.notifyConfigured) notifyEl.checked = false;
    const notifyRow = document.getElementById('deployments-notify-row');
    notifyRow.style.opacity = data.notifyConfigured ? '' : '0.5';
    notifyRow.style.cursor = data.notifyConfigured ? '' : 'not-allowed';

    document.getElementById('deployments-auto-hint').textContent = autoHint(data, available, held);
    document.getElementById('deployments-notify-hint').textContent = notifyHint(data);

    // Deploy status is only meaningful once a deploy is under way, so the whole tile appears with the hold
    const statusKpi = document.getElementById('deployments-status-kpi');
    const statusBadge = document.getElementById('kpi-deploy-status-badge');
    const statusEl = document.getElementById('kpi-deploy-status');
    const statusUnit = document.getElementById('kpi-deploy-status-unit');
    const dispatchEl = document.getElementById('kpi-deploy-dispatch');
    statusKpi.hidden = !held;
    if (held) {
      const elapsed = data.deployStartedAt ? fmtElapsed(data.deployStartedAt) + ' elapsed' : '';
      if (inFlight.length > 0) {
        setBadge(statusBadge, 'warn', 'Draining');
        statusEl.textContent = inFlight.map(function (w) { return plural(w.count, w.kind); }).join(', ');
        statusUnit.textContent = elapsed || 'waiting for in-flight work to finish';
      } else {
        setBadge(statusBadge, 'running', 'Building');
        statusEl.textContent = 'Building and releasing the new image';
        // Blank without a clock, unlike Draining above: the value here is a whole sentence,
        // so filler beside it would add nothing. Only a pre-clock hold reaches that.
        statusUnit.textContent = elapsed;
      }
      // Identical in both phases deliberately: the pause is a property of deploying,
      // not of a phase, so varying the wording would imply it varies with the phase.
      dispatchEl.textContent = 'New dispatches are paused until the deploy completes.';
    }

    // Last deploy outcome — persists after the hold clears, survives restarts.
    // Reserved rather than conditional: this goes from absent to present on the poll right
    // after a deploy lands, which is exactly when someone is watching. A grid reflow at that
    // moment costs more than an empty tile does on a first run.
    const outcomeBadge = document.getElementById('kpi-deploy-outcome-badge');
    const outcomeCommit = document.getElementById('kpi-deploy-outcome-commit');
    const outcomeWhen = document.getElementById('kpi-deploy-outcome-when');
    const outcomeMeta = document.getElementById('kpi-deploy-outcome-meta');
    if (!outcome) {
      setBadge(outcomeBadge, 'neutral', 'None yet');
      outcomeCommit.textContent = '\\u2014';
      outcomeWhen.textContent = '';
      outcomeMeta.textContent = 'No self-deploy has completed on this orchestrator.';
    } else {
      // Vocabulary follows drawer.ts's shared status mapping: completed/failed, with warn
      // reserved for a thing that finished but is not wholly right — the same call
      // review_failed gets. A release whose sidecar is missing serves every route but
      // /mcp, so it is degraded rather than failed.
      if (outcome.kind === 'deployed-ok') {
        setBadge(outcomeBadge, 'success', 'Completed');
      } else if (outcome.kind === 'deployed-not-serving') {
        setBadge(outcomeBadge, 'warn', 'Degraded');
      } else {
        setBadge(outcomeBadge, 'fail', 'Failed');
      }
      // A build failure names the commit it tried, not the one running, so this can
      // legitimately differ from the tile beside it. Only that case says so — for the
      // other two the commit here and the running one are the same value.
      outcomeCommit.innerHTML = commitLink(data.repo, outcome.commit) || '\\u2014';
      outcomeWhen.textContent = outcome.timestamp ? fmtAgo(outcome.timestamp) : '';
      outcomeMeta.textContent = outcome.kind === 'build-failed' ? 'attempted — never released' : '';
    }

    // What went wrong is a page-level notice, not a footnote inside a tile: a KPI trend
    // line is where secondary context goes, and a dead knowledge graph is not secondary.
    // The troubled flag is decided above because the deploy control shares it — one
    // condition, so the notice and the way to act on it cannot appear without each other.
    const outcomeAlert = document.getElementById('deployments-outcome-alert');
    outcomeAlert.hidden = !troubled;
    if (troubled) {
      const degraded = outcome.kind === 'deployed-not-serving';
      outcomeAlert.className = 'alert ' + (degraded ? 'warn' : 'fail');
      const title = degraded
        ? 'Released, but the knowledge graph is not serving'
        : 'Deploy did not release';
      const explain = degraded
        ? '/mcp answers 503 while every other route is healthy. Deploy now, below, rebuilds and releases the same commit.'
        : 'The running version is unchanged, and the commit is still available to deploy.';
      // The record carries a one-line reason on purpose. flyctl's real output is a 64 KB
      // tail that is logged and never stored, because the KG token rides in its argv and a
      // stored copy would outlive a rotating log and be served on every status poll.
      // Naming where the output is beats reproducing it somewhere it should not be.
      outcomeAlert.innerHTML =
        '<div class="alert-icon">' + (degraded ? '!' : '\\u00d7') + '</div>'
        + '<div style="flex:1">'
        + '<div class="alert-title">' + window.esc(title) + '</div>'
        + '<div class="alert-desc">' + window.esc(explain) + '</div>'
        + (outcome.detail ? '<div class="alert-desc" style="margin-top:4px; font-family: var(--font-mono)">' + window.esc(outcome.detail) + '</div>' : '')
        + '<div class="alert-desc" style="margin-top:4px">Full output is in the orchestrator logs.</div>'
        + '</div>';
    }

    // Availability is the least of the three signals here, so it rides in the label as
    // a tag. The commits it was derived from are the value.
    const badgeEl = document.getElementById('kpi-deploy-badge');
    if (available === true) {
      setBadge(badgeEl, 'warn', 'Available');
    } else if (available === false) {
      setBadge(badgeEl, 'success', 'Up to date');
    } else {
      setBadge(badgeEl, 'neutral', 'Unknown');
    }

    // Built from whichever commits resolved rather than branching on the verdict:
    // two differing commits render as a comparison, equal ones collapse to one, and
    // an unstamped running commit leaves just the head — no case needs special text.
    const links = [];
    if (data.runningCommit) links.push(commitLink(data.repo, data.runningCommit));
    if (data.headCommit && data.headCommit !== data.runningCommit) {
      links.push(commitLink(data.repo, data.headCommit));
    }
    document.getElementById('kpi-deploy-commit').innerHTML = links.length ? links.join(' → ') : '—';
    document.getElementById('kpi-deploy-checked').textContent =
      data.checkedAt ? 'checked ' + fmtAgo(data.checkedAt) : 'not yet checked';

    const source = [];
    if (data.repo) source.push(data.repo);
    if (data.branch) source.push(data.branch);
    document.getElementById('kpi-deploy-source').textContent = source.join(' · ');

    // Nav indicator — shown only when a deployment is confirmed available
    const navCount = document.querySelector('[data-count="deploy-available"]');
    if (navCount) {
      if (available === true) {
        navCount.textContent = '1';
        navCount.hidden = false;
      } else {
        navCount.hidden = true;
      }
    }
  }

  async function triggerDeploy() {
    // Native confirm is this codebase's gate for consequential actions — destroying a
    // machine and deleting a secret both use it. A .modal would read better but its
    // only current user is the stepper, with its own open/close wiring.
    if (!confirm('Deploy now? New dispatches pause immediately and in-flight work drains before the build starts.')) return;
    clearMessage();
    const btn = document.getElementById('deployments-deploy-btn');
    btn.disabled = true;
    try {
      const res = await window.api('/api/deploy', { method: 'POST' });
      if (!res.ok && res.status !== 401) {
        let message = 'Deploy failed to start';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        showMessage('error', 'Deploy failed to start — ' + message);
      }
    } catch (err) {
      showMessage('error', 'Deploy failed to start — ' + String(err));
    } finally {
      // finally, not the success path: returning early there left the button dead
      // whenever a fast failure cleared the hold before the next poll could hide it.
      btn.disabled = false;
      loadDeployments();
    }
  }

  async function saveDeployPolicy() {
    clearMessage();
    // Sends only the flags and override fields present, and re-renders from the response
    // rather than the form state — the server's view decides whether flags are meaningful,
    // and an optimistic update would show a hint that is not true yet.
    // Omits the announcement flag while it is unavailable, so saving cannot overwrite a
    // stored preference with the forced-unchecked display.
    const notifyEl = document.getElementById('deployments-notify');
    const watchedRepoEl = document.getElementById('deployments-watched-repo');
    const watchedRefEl = document.getElementById('deployments-watched-ref');
    const patch = { autoDeploy: document.getElementById('deployments-auto').checked };
    if (!notifyEl.disabled) patch.notifyAvailable = notifyEl.checked;
    // Send null to clear the override when the field is blank.
    patch.watchedRepo = watchedRepoEl.value.trim() || null;
    patch.watchedRef = watchedRefEl.value || null;
    try {
      const res = await window.api('/api/deploy-policy', { method: 'POST', body: JSON.stringify(patch) });
      if (!res.ok && res.status !== 401) {
        showMessage('error', 'Could not save the deployment policy — the settings may not reflect what is stored.');
      }
    } catch (err) {
      showMessage('error', 'Could not save the deployment policy — ' + String(err));
    }
    loadDeployments();
  }

  async function checkNow() {
    const btn = document.getElementById('deployments-check-now-btn');
    btn.disabled = true;
    clearMessage();
    try {
      const res = await window.api('/api/deploy-check', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(function () { return {}; });
        showMessage('warning', 'Check failed — ' + (body.error || res.status));
      }
    } catch (err) {
      showMessage('warning', 'Check failed — ' + String(err));
    } finally {
      btn.disabled = false;
      loadDeployments();
    }
  }

  window.loadDeployments = loadDeployments;
  window.triggerDeploy = triggerDeploy;
  window.saveDeployPolicy = saveDeployPolicy;
  window.refreshPolicyDirty = refreshPolicyDirty;
  window.loadDeployRefs = loadDeployRefs;
  window.checkNow = checkNow;

  async function loadKgStatus() {
    const card = document.getElementById('kg-refresh-card');
    try {
      const res = await window.api('/api/kg/status');
      if (!res.ok) { card.hidden = true; return; }
      const data = await res.json();
      card.hidden = false;
      const badge = document.getElementById('kg-refresh-badge');
      // Use the stage field for fine-grained badge states; fall back to running for
      // older orchestrator responses that lack it.
      const stage = data.stage || (data.running ? 'checking' : 'idle');
      if (stage === 'checking') {
        setBadge(badge, 'running', 'checking');
      } else if (stage === 'ingest-running') {
        setBadge(badge, 'running', 'running');
      } else if (stage === 'snapshot-landed') {
        setBadge(badge, 'running', 'landing');
      } else if (stage === 'staging') {
        setBadge(badge, 'running', 'staging');
      } else if (stage === 'serving') {
        setBadge(badge, 'ok', 'serving');
      } else if (stage === 'reverted') {
        setBadge(badge, 'warn', 'reverted');
      } else if (stage === 'failed') {
        setBadge(badge, 'fail', 'failed');
      } else if (data.kgDegraded) {
        setBadge(badge, 'warn', 'degraded');
      } else if (data.lastRefresh?.gate === 'ingest-needed') {
        setBadge(badge, 'neutral', 'stale');
      } else {
        setBadge(badge, 'ok', 'serving');
      }
      document.getElementById('kg-refresh-stamp').textContent =
        'Served graph stamp: ' + (data.servedStamp || 'baked image graph');
      // Stage-specific in-progress text, otherwise show last-refresh summary.
      let progressText = '';
      if (stage === 'checking') progressText = 'Checking KG source repo for a newer snapshot\u2026';
      else if (stage === 'ingest-running') progressText = 'Runner job dispatched \u2014 waiting for snapshot commit\u2026';
      else if (stage === 'snapshot-landed') progressText = 'Snapshot commit confirmed \u2014 starting local staging\u2026';
      else if (stage === 'staging') progressText = 'Staging new graph overlay\u2026';
      const last = data.lastRefresh;
      const lastText = !last
        ? 'No refresh has run since boot.'
        : last.gate === 'ingest-needed'
        ? 'Last refresh: ' + last.detail
        : 'Last refresh: ' + (last.ok ? 'ok' : 'failed at gate "' + (last.gate || '?') + '"') + ' \u2014 ' + last.detail;
      document.getElementById('kg-refresh-last').textContent = progressText || lastText;
      document.getElementById('kg-refresh-btn').disabled = !!data.running || !!data.deployHeld;
    } catch (e) { card.hidden = true; }
  }

  window.triggerKgRefresh = async function () {
    const btn = document.getElementById('kg-refresh-btn');
    btn.disabled = true;
    try {
      const res = await window.api('/api/kg/refresh', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(function () { return {}; });
        if (res.status === 422 && body.precondition === 'callback-unconfigured') {
          showMessage('warning', 'Refresh requires a configured runner callback \u2014 set RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET on the orchestrator.');
        } else if (res.status === 409 && body.error === 'deploy-in-progress') {
          showMessage('warning', 'A deploy is in progress \u2014 try again after it completes.');
        } else if (res.status === 409) {
          showMessage('warning', 'A refresh is already in progress.');
        } else {
          showMessage('warning', 'Refresh refused \u2014 ' + (body.error || String(res.status)));
        }
      }
    } catch (err) { showMessage('warning', 'Refresh failed \u2014 ' + String(err)); }
    setTimeout(loadKgStatus, 1000);
  };

  window.registerPage('deployments', function () { loadDeployments(); loadKgStatus(); setInterval(loadDeployments, 30000); setInterval(loadKgStatus, 15000); });
})();
`;
