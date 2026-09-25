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
      <div class="section-h" id="drawer-pilot-heading" hidden><h3>Restate attempt</h3><span class="section-meta" id="drawer-pilot-state-badge"></span></div>
      <div id="drawer-pilot" hidden>
        <div id="drawer-pilot-unavailable"></div>
        <div id="drawer-pilot-evidence-flags"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div id="drawer-pilot-owner"></div>
          <div id="drawer-pilot-links"></div>
        </div>
        <div id="drawer-pilot-snapshot"></div>
        <div class="section-h"><h3>Review cycles</h3><span class="section-meta" id="drawer-pilot-cycle-count"></span></div>
        <div id="drawer-pilot-cycles"></div>
        <div class="section-h"><h3>Tool activity</h3><span class="section-meta" id="drawer-pilot-activity-count"></span></div>
        <div id="drawer-pilot-activity"></div>
        <button id="drawer-pilot-activity-more" type="button" class="btn btn-sm" style="margin:8px 0 20px" hidden>Load more</button>
        <div class="section-h"><h3>Recovery actions</h3></div>
        <div id="drawer-pilot-actions" style="margin-bottom:20px"></div>
      </div>
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
  // Fixed, capped page size for the tool-activity fetch — the server itself caps at 500
  // (AII-806), but this keeps a single page small and pagination explicit via "Load more"
  // rather than ever accumulating unbounded pages in one render pass.
  const PILOT_ACTIVITY_PAGE_SIZE = 50;
  let currentJobId = null;
  let currentJobTerminal = false;
  let mappingsCache = null;
  let drawerRefreshTimer = null;
  let drawerRefreshInFlightFor = null;
  // Restate review-fix attempt state (AII-808). Kept outside renderPilotAttempt so a
  // background 5s refresh of the same attempt can leave an in-progress activity
  // pagination alone instead of silently resetting it back to page one.
  let currentAttemptId = null;
  // True once page one of tool activity has been successfully fetched for currentAttemptId —
  // deliberately independent of "is this a new attempt", so an attempt read that itself
  // failed (error/503) is never mistaken by the next refresh for "activity already loaded".
  let pilotActivityLoaded = false;
  let pilotActivityEvents = [];
  let pilotActivityCursor = null;
  let pilotActivityTruncated = false;
  // null | 'initial' | 'more' — which activity fetch most recently failed, so the render
  // can show an explicit unavailable state with a retry path instead of looking like zero
  // (or complete) activity.
  let pilotActivityError = null;
  // Attempt id the recovery-actions panel is currently rendered for. Kept separate from
  // currentAttemptId's eager reset so a background refresh of the same attempt never
  // re-creates the panel and wipes a visible action status or in-progress Adopt inputs.
  let pilotActionsAttemptId = null;

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

  // Same buckets as fmtAgo, but signed — a deadline is usually in the future, where
  // "5m ago" would read backwards.
  function fmtRelative(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const suffix = diff >= 0 ? ' from now' : ' ago';
    if (abs < 60000) return 'just now';
    if (abs < 3600000) return Math.floor(abs / 60000) + 'm' + suffix;
    if (abs < 86400000) return Math.floor(abs / 3600000) + 'h' + suffix;
    return Math.floor(abs / 86400000) + 'd' + suffix;
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

  // ---- Restate review-fix attempt section (AII-808) ----
  //
  // A legacy job carries no dispatchId-owned row in review_fix_attempts, so the GET
  // below 404s and the whole section stays hidden — the drawer renders exactly as it
  // did before this section existed. A dispatchId that *does* own an attempt renders
  // it alongside the existing sections, never replacing them (there is no parallel
  // timeline page).

  function resetPilotState() {
    currentAttemptId = null;
    pilotActivityLoaded = false;
    pilotActivityEvents = [];
    pilotActivityCursor = null;
    pilotActivityTruncated = false;
    pilotActivityError = null;
    pilotActionsAttemptId = null;
  }

  async function fetchReviewFixAttempt(attemptId) {
    try {
      const res = await window.api('/api/review-fix/attempts/' + encodeURIComponent(attemptId));
      if (res.status === 404 || res.status === 501) return { kind: 'none' };
      if (res.status === 503) return { kind: 'unavailable' };
      if (!res.ok) return { kind: 'error' };
      return { kind: 'ok', attempt: await res.json() };
    } catch (err) {
      console.error('Failed to fetch review-fix attempt:', err);
      return { kind: 'error' };
    }
  }

  async function fetchReviewFixActivityPage(attemptId, cursor) {
    const params = new URLSearchParams();
    params.set('pageSize', String(PILOT_ACTIVITY_PAGE_SIZE));
    if (cursor) {
      params.set('cursorProducerId', cursor.producerId);
      params.set('cursorSequence', String(cursor.sequence));
    }
    try {
      const res = await window.api('/api/review-fix/attempts/' + encodeURIComponent(attemptId) + '/activity?' + params.toString());
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.error('Failed to fetch review-fix activity:', err);
      return null;
    }
  }

  function pilotStateBadgeKind(attempt) {
    if (attempt.state === 'completed') {
      // A completed attempt with incomplete evidence or unconfirmed termination is not an
      // unqualified success — the badge itself must not read green, on top of the separate
      // evidence-flags warnings rendered just below it.
      return (attempt.evidenceComplete === false || attempt.terminationConfirmed === false) ? 'warn' : 'success';
    }
    if (attempt.state === 'cancelled' || attempt.state === 'failed') return 'fail';
    if (attempt.state === 'running' || attempt.state === 'prepared') return 'running';
    return 'neutral';
  }

  function renderPilotStateBadge(attempt) {
    const el = document.getElementById('drawer-pilot-state-badge');
    let html = '<span class="badge ' + pilotStateBadgeKind(attempt) + '"><span class="dot"></span>' + window.esc(attempt.state || 'unknown') + '</span>';
    if (attempt.deadlineAt != null) {
      const label = attempt.deadlineAt < Date.now() ? 'deadline passed ' : 'deadline in ';
      html += ' <span class="text-tertiary" style="font-size:11px">' + window.esc(label) + window.esc(fmtRelative(attempt.deadlineAt).replace(/ (from now|ago)$/, '')) + '</span>';
    }
    if (attempt.pendingFeedback) {
      html += ' <span class="badge info"><span class="dot"></span>pending feedback</span>';
    }
    el.innerHTML = html;
  }

  function renderPilotEvidenceFlags(attempt) {
    const el = document.getElementById('drawer-pilot-evidence-flags');
    const parts = [];
    // Explicit, never inferred from an absent field — mirrors AII-806's own contract note.
    if (!attempt.evidenceComplete) parts.push('<span class="badge warn"><span class="dot"></span>evidence incomplete</span>');
    if (!attempt.terminationConfirmed) parts.push('<span class="badge warn"><span class="dot"></span>termination unconfirmed</span>');
    el.innerHTML = parts.length ? '<div style="margin-bottom:10px">' + parts.join(' ') + '</div>' : '';
  }

  function renderPilotOwner(attempt) {
    const el = document.getElementById('drawer-pilot-owner');
    if (!attempt.owner) {
      el.innerHTML = '<div class="field"><div class="field-label">Lifecycle owner</div><div style="font-size:12.5px" class="text-tertiary">unknown — no owner recorded</div></div>';
      return;
    }
    let ownerText;
    try { ownerText = JSON.stringify(attempt.owner); } catch (e) { ownerText = String(attempt.owner); }
    el.innerHTML = '<div class="field"><div class="field-label">Lifecycle owner</div><div class="mono" id="drawer-pilot-owner-value" style="font-size:12px"></div></div>';
    // Owner is a free-form Record from the runner/GitHub side — textContent, never
    // interpolated into innerHTML, so it cannot inject markup no matter its shape.
    document.getElementById('drawer-pilot-owner-value').textContent = ownerText;
  }

  function renderPilotLinks(attempt, job) {
    const el = document.getElementById('drawer-pilot-links');
    if (!attempt.execution) {
      el.innerHTML = '<div class="field"><div class="field-label">Execution</div><div style="font-size:12.5px" class="text-tertiary">launch state unknown — no execution recorded yet</div></div>';
      return;
    }
    const repoParts = repoPartsForJob(job, null);
    let html = '<div class="field"><div class="field-label">Workflow run</div><div style="font-size:12.5px">';
    if (repoParts) {
      // The URL is assembled from repoParts.owner/repo and githubRunId before either helper
      // runs — window.safeUrl() validates the scheme but does not escape quotes, so the
      // final attribute value still needs window.escAttr() or an embedded '"' breaks out of
      // href="..." and lets the remainder of the string land as new, live HTML attributes.
      const runUrl = 'https://github.com/' + repoParts.owner + '/' + repoParts.repo + '/actions/runs/' + attempt.execution.githubRunId;
      html += '<a class="text-accent" href="' + window.escAttr(window.safeUrl(runUrl)) + '" target="_blank">Run #' + window.esc(String(attempt.execution.githubRunId)) + ' &#8599;</a>';
      if (attempt.execution.githubRunAttempt > 1) {
        const attemptUrl = runUrl + '/attempts/' + attempt.execution.githubRunAttempt;
        html += ' <a class="text-accent" href="' + window.escAttr(window.safeUrl(attemptUrl)) + '" target="_blank">(attempt ' + window.esc(String(attempt.execution.githubRunAttempt)) + ' &#8599;)</a>';
      }
    } else {
      html += '<span class="mono">run ' + window.esc(String(attempt.execution.githubRunId)) + ' · attempt ' + window.esc(String(attempt.execution.githubRunAttempt)) + '</span>';
    }
    html += '</div></div>';
    el.innerHTML = html;
  }

  function renderPilotSnapshot(attempt) {
    const el = document.getElementById('drawer-pilot-snapshot');
    if (!attempt.snapshot) {
      el.innerHTML = '<div class="field-label" style="margin:10px 0 4px">Snapshot</div><div style="font-size:12.5px" class="text-tertiary">no snapshot recorded</div>';
      return;
    }
    const findings = attempt.snapshot.findings || [];
    const findingsText = findings.map(function (f) { return window.esc(f.findingKey) + ' v' + window.esc(String(f.version)); }).join(', ');
    let html = '<div class="field-label" style="margin:10px 0 4px">Snapshot</div>'
      + '<pre id="drawer-pilot-snapshot-text" class="mono" style="white-space:pre-wrap;font-size:11.5px;max-height:160px;overflow:auto;margin:0 0 6px"></pre>'
      + '<div style="font-size:11.5px" class="text-tertiary">' + findings.length + ' finding' + (findings.length === 1 ? '' : 's') + (findingsText ? ': ' + findingsText : '') + '</div>';
    el.innerHTML = html;
    // taskText is agent-authored free text — textContent only, same rule as owner above.
    document.getElementById('drawer-pilot-snapshot-text').textContent = attempt.snapshot.taskText || '';
  }

  function verdictBadge(verdict) {
    // No verdict yet must never read as a pass — this is the same "absent result can't
    // look like success" rule the failure-evidence panel already applies to steps.
    if (!verdict || verdict.approved === null || verdict.approved === undefined) {
      return '<span class="badge neutral"><span class="dot"></span>verdict pending</span>';
    }
    return verdict.approved
      ? '<span class="badge success"><span class="dot"></span>approved</span>'
      : '<span class="badge fail"><span class="dot"></span>changes requested</span>';
  }

  function renderPilotCycles(attempt) {
    const el = document.getElementById('drawer-pilot-cycles');
    const countEl = document.getElementById('drawer-pilot-cycle-count');
    const cycles = attempt.cycles || [];
    countEl.textContent = cycles.length + ' cycle' + (cycles.length === 1 ? '' : 's');
    if (!cycles.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">No review cycles recorded</div>';
      return;
    }
    let html = '';
    for (const cycle of cycles) {
      const inCommit = cycle.inputCommit ? '<span class="mono">' + window.esc(cycle.inputCommit.slice(0, 10)) + '</span>' : '<span class="text-tertiary">no input commit</span>';
      const outCommit = cycle.outputCommit ? '<span class="mono">' + window.esc(cycle.outputCommit.slice(0, 10)) + '</span>' : '<span class="text-tertiary">no output commit</span>';
      const dispositions = (cycle.dispositions || []).map(function (d) { return window.esc(d.key) + ': ' + window.esc(d.disposition); }).join(', ');
      const tests = (cycle.tests || []).map(function (t) { return window.esc(t.name) + ': ' + window.esc(t.status); }).join(', ');
      const usage = cycle.usage || {};
      const usageParts = [];
      if (usage.tokensIn != null) usageParts.push(window.esc(String(usage.tokensIn)) + ' in');
      if (usage.tokensOut != null) usageParts.push(window.esc(String(usage.tokensOut)) + ' out');
      if (usage.costUsd != null) usageParts.push('$' + window.esc(usage.costUsd.toFixed(2)));
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:12.5px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<span class="mono text-secondary">cycle ' + window.esc(String(cycle.cycle)) + '</span>'
        + verdictBadge(cycle.verdict)
        + '</div>'
        + '<div style="margin-top:4px">' + inCommit + ' &rarr; ' + outCommit + '</div>'
        + '<div class="text-tertiary" style="margin-top:4px">Dispositions: ' + (dispositions || 'none recorded') + '</div>'
        + '<div class="text-tertiary" style="margin-top:2px">Tests: ' + (tests || 'none recorded') + '</div>'
        + (cycle.verdict && cycle.verdict.reason ? '<div style="margin-top:4px"><strong>Reason:</strong> ' + window.esc(cycle.verdict.reason) + '</div>' : '')
        + (cycle.verdict && cycle.verdict.summary ? '<div style="margin-top:2px"><strong>Summary:</strong> ' + window.esc(cycle.verdict.summary) + '</div>' : '')
        + '<div class="text-tertiary" style="margin-top:4px">' + (usageParts.length ? usageParts.join(' · ') : 'usage unavailable') + ' · ' + window.esc(fmtAgo(cycle.completedAt)) + '</div>'
        + '</div>';
    }
    el.innerHTML = html;
  }

  function pilotActivityErrorBanner() {
    if (!pilotActivityError) return '';
    const message = pilotActivityError === 'initial'
      ? 'Could not load activity for this attempt.'
      : 'Could not load the next page of activity.';
    return '<div class="alert warn" style="margin:6px 0"><div class="alert-icon">&#9888;</div><div style="flex:1">'
      + '<div class="alert-title">Tool activity unavailable</div>'
      + '<div class="alert-desc">' + window.esc(message) + ' <button id="drawer-pilot-activity-retry" type="button" class="btn btn-sm" style="margin-left:6px">Retry</button></div>'
      + '</div></div>';
  }

  function wirePilotActivityRetry() {
    const retryBtn = document.getElementById('drawer-pilot-activity-retry');
    if (!retryBtn) return;
    retryBtn.onclick = pilotActivityError === 'initial'
      ? function () { return loadInitialPilotActivity(currentJobId, currentAttemptId); }
      : function () { return loadMorePilotActivity(); };
  }

  function renderPilotActivity() {
    const el = document.getElementById('drawer-pilot-activity');
    const countEl = document.getElementById('drawer-pilot-activity-count');
    const moreBtn = document.getElementById('drawer-pilot-activity-more');
    countEl.textContent = pilotActivityEvents.length + ' event' + (pilotActivityEvents.length === 1 ? '' : 's') + (pilotActivityTruncated ? ' · stream truncated' : '');
    const errorBanner = pilotActivityErrorBanner();
    if (!pilotActivityEvents.length) {
      // A fetch failure must never render as "nothing here" (empty/no-activity) or as
      // stale-but-current — it gets its own explicit banner with a retry path instead.
      el.innerHTML = errorBanner || (pilotActivityCursor
        ? '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">No events on this page — more activity may be available</div>'
        : (pilotActivityTruncated
          ? '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">Activity truncated — no events available</div>'
          : '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">No tool activity recorded</div>'));
      // A page can legitimately return zero events while still carrying a cursor
      // (e.g. every event on that page was redacted) — the control must stay
      // reachable so bounded-but-incomplete data never masquerades as "nothing here".
      moreBtn.hidden = !pilotActivityCursor;
      moreBtn.onclick = loadMorePilotActivity;
      wirePilotActivityRetry();
      return;
    }
    let html = '';
    const payloads = [];
    for (let i = 0; i < pilotActivityEvents.length; i++) {
      const event = pilotActivityEvents[i];
      const payloadId = 'drawer-pilot-activity-payload-' + i;
      html += '<div style="padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:12px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<span class="mono text-secondary">' + window.esc(event.kind) + '</span>'
        + '<span class="text-tertiary" style="font-size:11px">' + (event.cycle != null ? 'cycle ' + window.esc(String(event.cycle)) + ' · ' : '') + window.esc(fmtAgo(event.occurredAt)) + '</span>'
        + '</div>'
        + (event.payload != null
          ? '<pre id="' + window.escAttr(payloadId) + '" class="mono" style="white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;margin:4px 0 0"></pre>'
            + (event.truncated ? '<div class="text-tertiary" style="font-size:10.5px">payload truncated (' + window.esc(String(event.byteCount)) + ' bytes)</div>' : '')
          : '<div class="text-tertiary" style="font-size:10.5px">no payload recorded' + (event.truncated ? ' · truncated' : '') + '</div>')
        + '</div>';
      if (event.payload != null) payloads.push({ id: payloadId, text: event.payload });
    }
    el.innerHTML = html + errorBanner;
    // Tool output is untrusted runner/model text — assigned via textContent onto the
    // <pre> placeholders above, exactly like the failure-evidence stderr/stdout tails,
    // so a payload containing markup can never be parsed as HTML.
    for (const p of payloads) {
      const target = document.getElementById(p.id);
      if (target) target.textContent = p.text;
    }
    moreBtn.hidden = !pilotActivityCursor;
    moreBtn.onclick = loadMorePilotActivity;
    wirePilotActivityRetry();
  }

  async function loadInitialPilotActivity(jobId, attemptId) {
    const page = await fetchReviewFixActivityPage(attemptId, null);
    if (currentJobId !== jobId || currentAttemptId !== attemptId) return;
    if (!page) {
      pilotActivityError = 'initial';
      renderPilotActivity();
      return;
    }
    pilotActivityEvents = page.events;
    pilotActivityCursor = page.nextCursor;
    // Sticky: a later page reporting false must never erase an earlier page's true — once
    // the stream is known truncated for this attempt, that stays the case until the attempt
    // itself switches (see resetPilotState/isNewAttempt), not just until the next page.
    pilotActivityTruncated = pilotActivityTruncated || page.truncated;
    pilotActivityLoaded = true;
    pilotActivityError = null;
    renderPilotActivity();
  }

  async function loadMorePilotActivity() {
    // Capture identity before the await — a fast job/attempt switch or a drawer close while
    // this request is in flight must discard the response rather than concat it into
    // whatever activity list is current by the time it resolves.
    const jobId = currentJobId;
    const attemptId = currentAttemptId;
    const cursor = pilotActivityCursor;
    if (!attemptId || !cursor) return;
    const page = await fetchReviewFixActivityPage(attemptId, cursor);
    if (currentJobId !== jobId || currentAttemptId !== attemptId) return;
    if (!page) {
      pilotActivityError = 'more';
      renderPilotActivity();
      return;
    }
    pilotActivityEvents = pilotActivityEvents.concat(page.events);
    pilotActivityCursor = page.nextCursor;
    pilotActivityTruncated = pilotActivityTruncated || page.truncated;
    pilotActivityError = null;
    renderPilotActivity();
  }

  function setPilotActionStatus(text) {
    const el = document.getElementById('drawer-pilot-action-status');
    if (el) el.textContent = text;
  }

  async function runPilotAction(attemptId, action, body) {
    if (!window.isAdmin()) return;
    // "accepted" describes the POST being queued, never that the action has taken
    // effect — the attempt's own state badge above is the source of truth for that,
    // and the 5s auto-refresh will pick up the eventual transition to it.
    setPilotActionStatus(action + ' requested…');
    try {
      const res = await window.api('/api/review-fix/attempts/' + encodeURIComponent(attemptId) + '/' + action, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      let payload;
      try { payload = await res.json(); } catch (e) { payload = {}; }
      if (res.status === 202) {
        setPilotActionStatus(action + ' accepted' + (payload.status === 'durable-accepted' ? ' (queued — Restate temporarily unavailable)' : '') + '.');
      } else if (res.status === 409) {
        setPilotActionStatus(action + ' rejected: ' + (payload.error || 'conflict') + '.');
      } else if (res.status === 422) {
        setPilotActionStatus(action + ' rejected: execution reference did not verify.');
      } else if (res.status === 404) {
        setPilotActionStatus(action + ' failed: attempt not found.');
      } else if (res.status === 503 && payload.status === 'partial') {
        // Cancel's revoke-then-terminate split means a 503 here is not an outright
        // failure: authority may already be revoked even though termination wasn't
        // confirmed, so the message must say which half landed rather than "failed".
        if (payload.cancellation === 'unconfirmed') {
          setPilotActionStatus(action + ' partially applied: authority revoked, termination unconfirmed — reconcile before retrying. ' + (payload.detail || ''));
        } else {
          setPilotActionStatus(action + ' queued: authority revocation durably accepted, termination not yet requested. ' + (payload.detail || ''));
        }
      } else {
        setPilotActionStatus(action + ' failed (status ' + res.status + ').');
      }
    } catch (err) {
      console.error('review-fix ' + action + ' failed:', err);
      setPilotActionStatus(action + ' failed: request error.');
    }
  }

  // Reconcile/adopt/cancel reuse the same window.isAdmin() gate the Pipelines page
  // already uses for its own KG-refresh cancel button — no new permission mechanism.
  // There is deliberately no combined force-release action: cancel always revokes
  // authority before requesting termination, matching the two-step server contract.
  function renderPilotActions(attemptId) {
    const el = document.getElementById('drawer-pilot-actions');
    if (!window.isAdmin()) {
      el.innerHTML = '<div class="text-tertiary" style="font-size:12px">Recovery actions require admin access.</div>';
      return;
    }
    el.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<button id="drawer-pilot-reconcile" type="button" class="btn btn-sm">Reconcile</button>'
      + '<span style="display:flex;gap:4px;align-items:center">'
      + '<input id="drawer-pilot-adopt-run-id" class="input mono" placeholder="run id" style="width:100px;font-size:11.5px" />'
      + '<input id="drawer-pilot-adopt-run-attempt" class="input mono" placeholder="attempt #" style="width:80px;font-size:11.5px" />'
      + '<button id="drawer-pilot-adopt" type="button" class="btn btn-sm">Adopt</button>'
      + '</span>'
      + '<button id="drawer-pilot-cancel" type="button" class="btn btn-sm btn-danger">Cancel attempt</button>'
      + '</div>'
      + '<div id="drawer-pilot-action-status" class="text-tertiary" style="font-size:11.5px;margin-top:6px"></div>';

    // Each handler returns runPilotAction's promise — a real click never awaits it, but
    // returning it lets a caller (the test harness included) await the action to settle.
    document.getElementById('drawer-pilot-reconcile').onclick = function () {
      return runPilotAction(attemptId, 'reconcile');
    };
    document.getElementById('drawer-pilot-adopt').onclick = function () {
      const runId = document.getElementById('drawer-pilot-adopt-run-id').value.trim();
      const runAttempt = Number(document.getElementById('drawer-pilot-adopt-run-attempt').value.trim());
      if (!runId || !Number.isInteger(runAttempt) || runAttempt < 1) {
        setPilotActionStatus('Enter a valid run id and attempt number before adopting.');
        return undefined;
      }
      return runPilotAction(attemptId, 'adopt', { githubRunId: runId, githubRunAttempt: runAttempt });
    };
    document.getElementById('drawer-pilot-cancel').onclick = function () {
      if (confirm('Cancel this attempt? Authority is revoked first, then termination is requested.')) {
        return runPilotAction(attemptId, 'cancel');
      }
      return undefined;
    };
  }

  function hidePilotSection() {
    document.getElementById('drawer-pilot-heading').hidden = true;
    document.getElementById('drawer-pilot').hidden = true;
  }

  async function renderPilotAttempt(job, background) {
    if (!job.dispatchId) {
      resetPilotState();
      hidePilotSection();
      return;
    }
    const isNewAttempt = currentAttemptId !== job.dispatchId;
    if (isNewAttempt) {
      currentAttemptId = job.dispatchId;
      pilotActivityLoaded = false;
      pilotActivityEvents = [];
      pilotActivityCursor = null;
      pilotActivityTruncated = false;
      pilotActivityError = null;
    }
    const result = await fetchReviewFixAttempt(job.dispatchId);
    if (currentJobId !== job.id) return;
    if (result.kind === 'none' || result.kind === 'error') {
      // Deliberately leaves pilotActivityLoaded/currentAttemptId untouched: an attempt read
      // that itself failed must never be mistaken by the next refresh for "activity already
      // loaded", or a later successful background refresh would silently skip page one.
      hidePilotSection();
      return;
    }
    document.getElementById('drawer-pilot-heading').hidden = false;
    document.getElementById('drawer-pilot').hidden = false;
    if (result.kind === 'unavailable') {
      document.getElementById('drawer-pilot-state-badge').innerHTML = '';
      document.getElementById('drawer-pilot-unavailable').innerHTML =
        '<div class="alert warn" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Attempt data unavailable</div><div class="alert-desc">Restate could not be reached for this attempt. State, cycles, and activity below may be stale or missing.</div></div></div>';
      document.getElementById('drawer-pilot-evidence-flags').innerHTML = '';
      document.getElementById('drawer-pilot-owner').innerHTML = '';
      document.getElementById('drawer-pilot-links').innerHTML = '';
      document.getElementById('drawer-pilot-snapshot').innerHTML = '';
      document.getElementById('drawer-pilot-cycles').innerHTML = '';
      document.getElementById('drawer-pilot-cycle-count').textContent = '';
      document.getElementById('drawer-pilot-activity').innerHTML = '';
      document.getElementById('drawer-pilot-activity-count').textContent = '';
      document.getElementById('drawer-pilot-activity-more').hidden = true;
      // The read side just went dark, so any activity shown before it did is no longer
      // trustworthy — require a fresh page one once it recovers, rather than leaving
      // pilotActivityLoaded true and quietly keeping this wiped-out DOM on the next refresh.
      pilotActivityLoaded = false;
      pilotActivityError = null;
      // Recovery controls stay reachable even when the read side is degraded — an
      // unknown/unreadable attempt is exactly when reconcile/adopt/cancel matter most, and
      // none of them is a force-release that bypasses that uncertainty. Rendered once per
      // attempt (see pilotActionsAttemptId below), not on every degraded refresh.
      if (pilotActionsAttemptId !== job.dispatchId) {
        renderPilotActions(job.dispatchId);
        pilotActionsAttemptId = job.dispatchId;
      }
      return;
    }
    document.getElementById('drawer-pilot-unavailable').innerHTML = '';
    const attempt = result.attempt;
    renderPilotStateBadge(attempt);
    renderPilotEvidenceFlags(attempt);
    renderPilotOwner(attempt);
    renderPilotLinks(attempt, job);
    renderPilotSnapshot(attempt);
    renderPilotCycles(attempt);
    // Rendered once per attempt, not on every 5s refresh — recreating these buttons on a
    // background refresh of the same attempt would wipe a visible action status message and
    // any in-progress Adopt input the reader hasn't submitted yet.
    if (pilotActionsAttemptId !== job.dispatchId) {
      renderPilotActions(job.dispatchId);
      pilotActionsAttemptId = job.dispatchId;
    }
    if (!pilotActivityLoaded || !background) {
      await loadInitialPilotActivity(job.id, job.dispatchId);
      if (currentJobId !== job.id) return;
    }
    // A background refresh that already has page one loaded deliberately leaves an
    // in-progress activity pagination alone rather than re-fetching page one — the same
    // reason renderSteps preserves open evidence panels across its own 5s re-render.
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
    resetPilotState();
    hidePilotSection();
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
      await renderPilotAttempt(json.job, background);
      if (currentJobId !== id) return;
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
    resetPilotState();
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
