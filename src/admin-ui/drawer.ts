export const drawerHtml = `
<div id="job-drawer-wrap" class="job-drawer-wrap" hidden>
  <div class="drawer-backdrop" onclick="closeJobDrawer()"></div>
  <div class="drawer">
    <div class="drawer-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="min-width:0;flex:1">
          <div id="drawer-issue-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px"></div>
          <h2 id="drawer-title" style="font-size:17px;font-weight:600;margin:0">—</h2>
          <div id="drawer-meta" style="font-size:12px;color:var(--fg-tertiary);margin-top:4px"></div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="closeJobDrawer()" title="Close">×</button>
      </div>
    </div>
    <div class="drawer-body">
      <div id="drawer-failure-alert"></div>
      <div class="section-h"><h3>Pipeline</h3><span class="section-meta" id="drawer-elapsed"></span></div>
      <div class="timeline" id="drawer-timeline"></div>
      <div class="section-h"><h3>Steps</h3><span class="section-meta" id="drawer-step-count"></span></div>
      <div id="drawer-steps"></div>
      <div class="section-h"><h3>Context</h3></div>
      <div id="drawer-context" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px"></div>
    </div>
    <div class="drawer-footer">
      <div></div>
      <div style="display:flex;gap:6px">
        <a id="drawer-logs-link" class="btn btn-sm" href="" target="_blank" hidden>View workflow logs ↗</a>
        <button id="drawer-local-logs" type="button" class="btn btn-sm" hidden>View local logs</button>
        <button class="btn btn-primary btn-sm" onclick="closeJobDrawer()">Close</button>
      </div>
    </div>
  </div>
</div>
`;

export const drawerScript = `
(function () {
  const DRAWER_REFRESH_MS = 5000;
  let currentJobId = null;
  let currentJobTerminal = false;
  let mappingsCache = null;
  let drawerRefreshTimer = null;
  let drawerRefreshInFlightFor = null;

  function isTerminalJobStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'review_failed' || status === 'dispatch-failed';
  }

  async function ensureMappings() {
    if (!mappingsCache) {
      const r = await window.api('/api/mappings');
      mappingsCache = await r.json();
    }
    return mappingsCache;
  }

  function fmtAgo(tsOrIso) {
    const ms = typeof tsOrIso === 'number' ? tsOrIso : new Date(tsOrIso).getTime();
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function fmtDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m + 'm ' + s + 's';
  }

  function reviewStatusLabel(job, steps) {
    if (job && job.status === 'review_failed' && reviewIncompleteInfo(job, steps)) return 'review incomplete';
    return job && job.status === 'review_failed' ? 'review failed' : ((job && job.status) || 'unknown');
  }

  function badgeForJobStatus(job, steps) {
    const s = job && job.status;
    let kind;
    if (s === 'running') kind = 'running';
    else if (s === 'failed' || s === 'timed_out') kind = 'fail';
    else if (s === 'review_failed') kind = 'warn';
    else if (s === 'completed') kind = 'success';
    else kind = 'neutral';
    const label = reviewStatusLabel(job, steps);
    return '<span class="badge ' + kind + '"><span class="dot"></span>' + window.esc(label) + '</span>';
  }

  function reviewIncompleteCauseFromFailure(failure) {
    if (!failure || typeof failure.code !== 'string') return null;
    if (failure.code === 'REVIEWER_TURNS_EXHAUSTED') {
      return {
        title: 'Review incomplete',
        detail: 'The post-push reviewer ran out of turns before reaching a verdict.',
        cause: 'reviewer turn limit',
        limit: failure.reviewMaxTurns,
        reviewer: reviewerNameFromFailure(failure),
        failureDetails: failure.message || null,
        reviewEvidence: null,
      };
    }
    if (failure.code === 'PROVIDER_UNAVAILABLE' && (!failure.stage || String(failure.stage).includes('review'))) {
      return {
        title: 'Review incomplete',
        detail: 'The model provider was unavailable during automated review.',
        cause: 'provider unavailable',
        limit: failure.reviewMaxTurns,
        reviewer: reviewerNameFromFailure(failure),
        failureDetails: failure.message || null,
        reviewEvidence: null,
      };
    }
    return null;
  }

  function reviewerNameFromFailure(failure) {
    const stage = failure && typeof failure.stage === 'string' ? failure.stage : '';
    const slashTail = stage.split('/').pop() || '';
    const reviewMatch = slashTail.match(/^(.+?)-review-\\d+$/);
    if (reviewMatch) return reviewMatch[1].replace(/-/g, ' ');
    const dotParts = stage.split('.');
    const dotTail = dotParts[dotParts.length - 1] || '';
    return dotTail && dotTail !== stage ? dotTail.replace(/-/g, ' ') : null;
  }

  function parseStepInputs(step) {
    try {
      return JSON.parse(step.inputsJson || '{}');
    } catch (e) {
      return {};
    }
  }

  function reviewEvidenceFromOutputs(outputs) {
    if (!outputs) return null;
    if (outputs.partial && typeof outputs.partial === 'object') return reviewEvidenceFromOutputs(outputs.partial);
    if (typeof outputs.summary === 'string' && outputs.summary.trim()) return outputs.summary;
    if (Array.isArray(outputs.checks) && outputs.checks.length > 0) {
      return outputs.checks.map(function (check) {
        return check && typeof check.check === 'string' ? check.check + ': ' + (check.evidence || '') : null;
      }).filter(Boolean).join(', ');
    }
    return null;
  }

  function reviewIncompleteCauseFromStep(step) {
    if (step.status !== 'failed') return null;
    const inputs = parseStepInputs(step);
    if (inputs.gates === false || inputs.reviewerProvenance === 'branch') return null;
    const outputs = parseStepOutputs(step);
    const failureCause = reviewIncompleteCauseFromFailure(outputs && outputs.failure);
    if (failureCause) {
      if (inputs && typeof inputs.reviewerId === 'string' && inputs.reviewerId) {
        failureCause.reviewer = inputs.reviewerId;
      }
      failureCause.reviewEvidence = reviewEvidenceFromOutputs(outputs);
      return failureCause;
    }
    if (outputs && outputs.terminationReason === 'invalid_review') {
      return {
        title: 'Review incomplete',
        detail: 'Automated review returned invalid output before reaching a verdict.',
        cause: 'invalid review output',
        limit: null,
        reviewer: null,
        failureDetails: outputs.feedback || null,
        reviewEvidence: reviewEvidenceFromOutputs(outputs),
      };
    }
    return null;
  }

  function reviewIncompleteInfo(job, steps) {
    if (!job || job.status !== 'review_failed') return null;
    const jobCause = reviewIncompleteCauseFromFailure(job.failure);
    const sourceSteps = Array.isArray(steps) ? steps : [];
    for (const step of sourceSteps) {
      if (!jobCause && parseStepInputs(step).gates !== true && !parseStepOutputs(step).terminationReason) continue;
      const cause = reviewIncompleteCauseFromStep(step);
      if (cause) return cause;
    }
    return jobCause;
  }

  function renderIssueRow(job, steps) {
    const issueRow = document.getElementById('drawer-issue-row');
    issueRow.innerHTML =
      '<span class="mono text-tertiary" style="font-size:12px">' + window.esc(job.issueIdentifier || '—') + '</span>'
      + badgeForJobStatus(job, steps);
    if (job.dispatchNumber > 1) {
      issueRow.innerHTML += '<span class="badge warn"><span class="dot"></span>attempt ' + job.dispatchNumber + '</span>';
    }
  }

  function renderTitle(job) {
    document.getElementById('drawer-title').textContent = job.issueTitle || job.issueIdentifier || '—';
  }

  function renderMeta(job) {
    const meta = document.getElementById('drawer-meta');
    const parts = [];
    if (job.teamKey) parts.push('<span class="mono">' + window.esc(job.teamKey) + '</span>');
    if (job.repo) parts.push(window.esc(job.repo));
    if (job.executionMode) parts.push(window.esc(job.executionMode));
    parts.push('started ' + fmtAgo(job.dispatchedAt));
    meta.innerHTML = parts.join(' · ');
  }

  function renderElapsed(job, steps) {
    const elapsedEl = document.getElementById('drawer-elapsed');
    let endMs = null;
    if (job.status === 'completed' || job.status === 'review_failed' || job.status === 'failed' || job.status === 'timed_out') {
      if (job.completedAt) {
        endMs = job.completedAt;
      } else {
        // Try to get from the most recent step
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].endedAt) {
            endMs = new Date(steps[i].endedAt).getTime();
            break;
          }
        }
      }
    }
    const startMs = job.dispatchedAt;
    const durationMs = endMs ? endMs - startMs : Date.now() - startMs;
    elapsedEl.textContent = fmtDuration(durationMs) + ' elapsed';
  }

  function renderFailureAlert(job, steps) {
    const alertEl = document.getElementById('drawer-failure-alert');
    const incomplete = reviewIncompleteInfo(job, steps);
    if (job.status === 'failed') {
      alertEl.innerHTML = '<div class="alert fail" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Job failed</div><div class="alert-desc">Failed during execution.</div></div></div>';
    } else if (incomplete) {
      const parts = [];
      if (incomplete.reviewer) parts.push('Reviewer: ' + window.esc(incomplete.reviewer));
      parts.push('Cause: ' + window.esc(incomplete.cause));
      if (incomplete.limit != null) parts.push('Limit: ' + window.esc(String(incomplete.limit)) + ' turns');
      alertEl.innerHTML = '<div class="alert warn" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Review incomplete</div><div class="alert-desc">'
        + window.esc(incomplete.detail)
        + '<div class="mono text-tertiary" style="margin-top:6px;font-size:11px">' + parts.join(' · ') + '</div>'
        + (incomplete.failureDetails ? '<div style="margin-top:6px"><strong>Details:</strong> ' + window.esc(String(incomplete.failureDetails).slice(0, 300)) + '</div>' : '')
        + (incomplete.reviewEvidence ? '<div style="margin-top:6px"><strong>Partial review evidence:</strong> ' + window.esc(String(incomplete.reviewEvidence).slice(0, 300)) + '</div>' : '')
        + '</div></div></div>';
    } else if (job.status === 'review_failed') {
      alertEl.innerHTML = '<div class="alert warn" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Review failed</div><div class="alert-desc">Implementation opened a PR, but automated review did not approve it.</div></div></div>';
    } else if (job.status === 'timed_out') {
      alertEl.innerHTML = '<div class="alert warn" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Job timed out</div><div class="alert-desc">Workflow exceeded timeout.</div></div></div>';
    } else {
      alertEl.innerHTML = '';
    }
  }

  function renderTimeline(job, steps) {
    const latestRunningStep = (Array.isArray(steps) ? steps : []).find(function (s) { return s.status === 'running'; });
    const phases = [
      { label: 'Queued', detail: 'queued in ticketing system' },
      { label: 'Planning', detail: 'claude-plan.yml' },
      { label: 'Implementing', detail: job.executionMode ? window.esc(job.executionMode) + ' run' : 'implementation run' },
      { label: 'Review', detail: reviewIncompleteInfo(job, steps) ? 'post-push review incomplete' : (job.status === 'review_failed' ? 'post-push review needs attention' : (latestRunningStep && latestRunningStep.stepId === 'post-push-review' ? 'post-push review running' : (job.prUrl ? 'PR opened: #' + window.esc(job.prUrl.split('/').pop() || '') : 'awaiting PR'))) },
      { label: 'Done', detail: 'merged' }
    ];

    let activeIndex = 0;
    const mode = job.executionMode || '';
    if (mode === 'planning') {
      activeIndex = 1;
    } else if (mode === 'fly-machines' || mode === 'github-actions' || mode === 'local-docker') {
      activeIndex = 2;
      if (job.prUrl) activeIndex = 3;
      if (job.status === 'completed' && job.prUrl) activeIndex = 4;
      if (job.status === 'review_failed') activeIndex = 3;
    } else {
      activeIndex = 0;
    }
    if (latestRunningStep && latestRunningStep.stepId === 'post-push-review') {
      activeIndex = 3;
    }

    const timelineEl = document.getElementById('drawer-timeline');
    let html = '';
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      let cls = '';
      let markerText = String(i + 1);
      if (i < activeIndex) {
        cls = 'done';
        markerText = '&#10003;';
      } else if (i === activeIndex) {
        if (job.status === 'failed' || job.status === 'timed_out' || job.status === 'review_failed') {
          cls = 'fail';
          markerText = '&#10007;';
        } else if (job.status === 'running') {
          cls = 'active';
          markerText = '&bull;';
        }
      }
      html += '<div class="tl-item">'
        + '<div class="tl-marker ' + cls + '">' + markerText + '</div>'
        + '<div class="tl-content">'
        + '<div class="tl-title">' + window.esc(phase.label) + '</div>'
        + '<div class="tl-meta">' + phase.detail + '</div>'
        + '</div>'
        + '</div>';
    }
    timelineEl.innerHTML = html;
  }

  function parseStepOutputs(step) {
    try {
      return JSON.parse(step.outputsJson || '{}');
    } catch (e) {
      return {};
    }
  }

  function captureOpenEvidenceIds() {
    const ids = [];
    const stepsEl = document.getElementById('drawer-steps');
    if (!stepsEl) return ids;
    const open = stepsEl.querySelectorAll('details.failure-evidence[open]');
    for (let i = 0; i < open.length; i++) {
      if (open[i].id) ids.push(open[i].id);
    }
    return ids;
  }

  function restoreOpenEvidenceIds(ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.setAttribute('open', '');
    }
  }

  function captureEvidenceScrollPositions() {
    const positions = {};
    const stepsEl = document.getElementById('drawer-steps');
    if (!stepsEl) return positions;
    const pres = stepsEl.querySelectorAll('pre[id]');
    for (let i = 0; i < pres.length; i++) {
      positions[pres[i].id] = pres[i].scrollTop;
    }
    return positions;
  }

  function restoreEvidenceScrollPositions(positions) {
    for (const id in positions) {
      const el = document.getElementById(id);
      if (el) el.scrollTop = positions[id];
    }
  }

  function renderSteps(steps) {
    const stepsEl = document.getElementById('drawer-steps');
    const countEl = document.getElementById('drawer-step-count');
    // A 5s auto-refresh replaces this element's innerHTML wholesale; without capturing
    // and re-applying which <details> were open, every re-render silently collapses
    // whatever evidence panel the reader had open (and resets its scroll/selection).
    const openIds = captureOpenEvidenceIds();
    const scrollPositions = captureEvidenceScrollPositions();
    if (!steps || steps.length === 0) {
      stepsEl.innerHTML = '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">No step records</div>';
      countEl.textContent = 'no step records';
      return;
    }
    countEl.textContent = steps.length + ' step' + (steps.length === 1 ? '' : 's');
    let html = '';
    // Raw process output (stderrTail/stdoutTail) must land via textContent, never innerHTML —
    // collected here and assigned onto the <pre> placeholders below after stepsEl.innerHTML is set.
    const evidenceTails = [];
    for (const step of steps) {
      let badgeKind;
      if (step.status === 'running') badgeKind = 'running';
      else if (step.status === 'failed') badgeKind = 'fail';
      else if (step.status === 'completed' || step.status === 'passed') badgeKind = 'success';
      else badgeKind = 'neutral';

      const logsLink = step.logsUrl
        ? '<a class="btn btn-sm" href="' + window.safeUrl(step.logsUrl) + '" target="_blank" style="font-size:11px">Logs ↗</a>'
        : '';

      html += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:12.5px">'
        + '<div><span class="mono text-secondary">' + window.esc(step.stepId) + '</span>'
        + ' <span class="text-tertiary" style="margin-left:8px">' + window.esc(step.stepType) + '</span></div>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + logsLink
        + '<span class="badge ' + badgeKind + '"><span class="dot"></span>' + window.esc(step.status) + '</span>'
        + '</div>'
        + '</div>';

      const failure = parseStepOutputs(step).failure;
      if (step.status === 'failed' && failure && typeof failure.category === 'string') {
        const incomplete = reviewIncompleteCauseFromFailure(failure);
        const summaryBits = window.esc(failure.category)
          + (failure.code ? '/' + window.esc(failure.code) : '')
          + (failure.attempt != null ? ' · attempt ' + window.esc(String(failure.attempt)) : '');
        html += '<details id="failure-evidence-' + window.escAttr(step.stepId) + '" class="failure-evidence" style="margin:-2px 0 10px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">'
          + '<summary style="cursor:pointer;font-size:11.5px;color:var(--fg-tertiary)">Failure evidence · '
          + summaryBits
          + '</summary>'
          + '<div style="padding:8px 4px;font-size:12px">'
          + (incomplete ? '<div><strong>Review status:</strong> incomplete · ' + window.esc(incomplete.cause) + (incomplete.limit != null ? ' · limit ' + window.esc(String(incomplete.limit)) + ' turns' : '') + '</div>' : '')
          + (failure.code === 'SENSITIVE_FILES_BLOCKED'
            ? '<div><strong>Message:</strong><pre class="mono" style="white-space:pre-wrap;font-size:11px;margin:4px 0 0;max-height:240px;overflow:auto">' + window.esc(failure.message || '') + '</pre></div>'
            : '<div><strong>Message:</strong> ' + window.esc(failure.message || '') + '</div>')
          + (failure.exitCode != null ? '<div><strong>Exit code:</strong> ' + window.esc(String(failure.exitCode)) + '</div>' : '')
          + (failure.signal ? '<div><strong>Signal:</strong> ' + window.esc(failure.signal) + '</div>' : '')
          + (failure.evidence && failure.evidence.truncated ? '<div class="text-tertiary">evidence truncated</div>' : '')
          + (failure.evidence && failure.evidence.stderrTail
            ? '<div class="text-tertiary" style="margin-top:6px">stderr</div><pre id="failure-stderr-' + window.escAttr(step.stepId) + '" class="mono" style="white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto"></pre>'
            : '')
          + (failure.evidence && failure.evidence.stdoutTail
            ? '<div class="text-tertiary" style="margin-top:6px">stdout</div><pre id="failure-stdout-' + window.escAttr(step.stepId) + '" class="mono" style="white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto"></pre>'
            : '')
          + '</div>'
          + '</details>';
        evidenceTails.push({
          stepId: step.stepId,
          stderrTail: failure.evidence ? failure.evidence.stderrTail : undefined,
          stdoutTail: failure.evidence ? failure.evidence.stdoutTail : undefined,
        });
      }
    }
    stepsEl.innerHTML = html;
    for (const tail of evidenceTails) {
      if (tail.stderrTail) {
        const el = document.getElementById('failure-stderr-' + tail.stepId);
        if (el) el.textContent = tail.stderrTail;
      }
      if (tail.stdoutTail) {
        const el = document.getElementById('failure-stdout-' + tail.stepId);
        if (el) el.textContent = tail.stdoutTail;
      }
    }
    restoreOpenEvidenceIds(openIds);
    restoreEvidenceScrollPositions(scrollPositions);
  }

  function renderContext(job, mappings) {
    const contextEl = document.getElementById('drawer-context');
    const fields = [];

    const mapping = mappings && job.teamKey ? mappings[job.teamKey] : null;
    const repoParts = repoPartsForJob(job, mapping);

    if (job.issueIdentifier) {
      // The server resolves issueUrl through the mapping's ticketing provider, so the
      // drawer never has to know which tracker (or which Jira site) a project uses.
      const valueHtml = job.issueUrl
        ? '<a class="text-accent" href="' + window.safeUrl(job.issueUrl) + '" target="_blank">' + window.esc(job.issueIdentifier) + ' &#8599;</a>'
        : window.esc(job.issueIdentifier);
      fields.push({ label: 'Issue', value: valueHtml });
    }

    if (job.repo) {
      const repoDisplay = repoParts ? window.esc(repoParts.owner) + '/' + window.esc(repoParts.repo) : window.esc(job.repo);
      fields.push({ label: 'Repository', value: '<span class="mono">' + repoDisplay + '</span>' });
    }

    if (job.teamKey) {
      fields.push({ label: 'Project', value: '<span class="mono">' + window.esc(job.teamKey) + '</span>' });
    }

    if (job.executionMode) {
      let runnerVal = window.esc(job.executionMode);
      if (job.runnerMode && job.runnerMode !== job.executionMode) {
        runnerVal += ' <span style="color:var(--fg-tertiary)">(' + window.esc(job.runnerMode) + ')</span>';
      }
      fields.push({ label: 'Runner', value: runnerVal });
    }

    if (job.machineId) {
      fields.push({ label: 'Machine', value: '<span class="mono">' + window.esc(job.machineId) + '</span>' });
    }

    if (job.prUrl) {
      const prNum = job.prUrl.split('/').pop() || '';
      fields.push({
        label: 'Pull request',
        value: '<a class="text-accent" href="' + window.safeUrl(job.prUrl) + '" target="_blank">#' + window.esc(prNum) + ' &#8599;</a>'
      });
    }

    let html = '';
    for (const f of fields) {
      html += '<div class="field"><div class="field-label">' + window.esc(f.label) + '</div><div style="font-size:12.5px">' + f.value + '</div></div>';
    }
    contextEl.innerHTML = html;
  }

  function renderLogsLink(job, mappings) {
    const localLogs = document.getElementById('drawer-local-logs');
    localLogs.hidden = job.executionMode !== 'local-docker' || !job.machineId;
    localLogs.onclick = localLogs.hidden ? null : function () { window.openLocalJobLogs(job.id, job.issueIdentifier); };
    const logsLink = document.getElementById('drawer-logs-link');
    const mapping = mappings && job.teamKey ? mappings[job.teamKey] : null;
    const repoParts = repoPartsForJob(job, mapping);
    const hasWorkflowLogs = job.runId && job.executionMode === 'github-actions';
    if (hasWorkflowLogs && repoParts) {
      logsLink.href = 'https://github.com/' + repoParts.owner + '/' + repoParts.repo + '/actions/runs/' + job.runId;
      logsLink.textContent = 'View workflow logs ↗';
      logsLink.removeAttribute('hidden');
    } else {
      logsLink.setAttribute('hidden', '');
      logsLink.removeAttribute('href');
    }
  }

  function repoPartsForJob(job, mapping) {
    if (job.repo && job.repo.includes('/')) {
      const parts = job.repo.split('/');
      if (parts[0] && parts[1]) return { owner: parts[0], repo: parts.slice(1).join('/') };
    }
    if (job.repo && mapping && mapping.owner) {
      return { owner: mapping.owner, repo: job.repo };
    }
    return null;
  }

  function renderDrawer(job, steps, mappings) {
    renderIssueRow(job, steps);
    renderTitle(job);
    renderMeta(job);
    renderElapsed(job, steps);
    renderFailureAlert(job, steps);
    renderTimeline(job, steps);
    renderSteps(steps);
    renderContext(job, mappings);
    renderLogsLink(job, mappings);
  }

  function resetDrawerContent() {
    document.getElementById('drawer-title').textContent = 'Loading…';
    document.getElementById('drawer-issue-row').innerHTML = '';
    document.getElementById('drawer-meta').innerHTML = '';
    document.getElementById('drawer-elapsed').textContent = '';
    document.getElementById('drawer-failure-alert').innerHTML = '';
    document.getElementById('drawer-timeline').innerHTML = '';
    document.getElementById('drawer-steps').innerHTML = '';
    document.getElementById('drawer-step-count').textContent = '';
    document.getElementById('drawer-context').innerHTML = '';
    document.getElementById('drawer-logs-link').setAttribute('hidden', '');
    document.getElementById('drawer-logs-link').removeAttribute('href');
    document.getElementById('drawer-local-logs').hidden = true;
    document.getElementById('drawer-local-logs').onclick = null;
  }

  function stopDrawerAutoRefresh() {
    if (drawerRefreshTimer) {
      clearInterval(drawerRefreshTimer);
      drawerRefreshTimer = null;
    }
  }

  function startDrawerAutoRefresh(id) {
    stopDrawerAutoRefresh();
    drawerRefreshTimer = setInterval(function () {
      refreshJobDrawer(id, { background: true });
    }, DRAWER_REFRESH_MS);
  }

  async function refreshJobDrawer(id, options) {
    if (drawerRefreshInFlightFor === id) return;
    drawerRefreshInFlightFor = id;
    const background = options && options.background === true;
    let mappings;
    try {
      mappings = await ensureMappings();
    } catch (err) {
      console.error('Failed to load mappings:', err);
      mappings = null;
    }

    try {
      const res = await window.api('/api/jobs/' + id + '/steps');
      if (currentJobId !== id) return;
      if (res.status === 404) {
        document.getElementById('drawer-title').textContent = 'Job not found';
        stopDrawerAutoRefresh();
        return;
      }
      if (!res.ok) {
        console.error('Failed to load job:', res.status);
        if (!background) document.getElementById('drawer-title').textContent = 'Failed to load job';
        return;
      }
      const json = await res.json();
      if (currentJobId !== id) return;
      renderDrawer(json.job, json.steps, mappings);
      // A finished job's steps cannot change — stop polling instead of collapsing
      // an open evidence panel and resetting scroll every 5s for no reason.
      currentJobTerminal = isTerminalJobStatus(json.job.status);
      if (currentJobTerminal) stopDrawerAutoRefresh();
    } catch (err) {
      console.error('Failed to fetch job steps:', err);
      if (!background && currentJobId === id) document.getElementById('drawer-title').textContent = 'Failed to load job';
    } finally {
      if (drawerRefreshInFlightFor === id) drawerRefreshInFlightFor = null;
    }
  }

  async function openJobDrawer(id) {
    stopDrawerAutoRefresh();
    currentJobId = id;
    // Only refreshJobDrawer's success path updates this — reset it here too, or a
    // terminal job followed by a running job whose first fetch fails leaves auto-refresh
    // permanently off, stuck on the previous job's stale value.
    currentJobTerminal = false;
    const wrap = document.getElementById('job-drawer-wrap');
    resetDrawerContent();
    wrap.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';

    await refreshJobDrawer(id, { background: false });
    if (currentJobId === id && !currentJobTerminal) startDrawerAutoRefresh(id);
  }

  function closeJobDrawer() {
    stopDrawerAutoRefresh();
    const wrap = document.getElementById('job-drawer-wrap');
    if (wrap) wrap.setAttribute('hidden', '');
    document.body.style.overflow = '';
    currentJobId = null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      const wrap = document.getElementById('job-drawer-wrap');
      if (wrap && !wrap.hasAttribute('hidden')) closeJobDrawer();
    }
  });

  window.openJobDrawer = openJobDrawer;
  window.closeJobDrawer = closeJobDrawer;
  // Exposed for the test harness to trigger a refresh directly, without a live timer.
  window.refreshJobDrawer = refreshJobDrawer;
})();
`;
