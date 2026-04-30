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
        <button class="btn btn-primary btn-sm" onclick="closeJobDrawer()">Close</button>
      </div>
    </div>
  </div>
</div>
`;

export const drawerScript = `
(function () {
  let currentJobId = null;
  let mappingsCache = null;

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

  function badgeForStatus(s) {
    let kind;
    if (s === 'running') kind = 'running';
    else if (s === 'failed' || s === 'timed_out') kind = 'fail';
    else if (s === 'completed') kind = 'success';
    else kind = 'neutral';
    const label = s || 'unknown';
    return '<span class="badge ' + kind + '"><span class="dot"></span>' + window.esc(label) + '</span>';
  }

  function renderIssueRow(job) {
    const issueRow = document.getElementById('drawer-issue-row');
    issueRow.innerHTML =
      '<span class="mono text-tertiary" style="font-size:12px">' + window.esc(job.issueIdentifier || '—') + '</span>'
      + badgeForStatus(job.status);
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
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'timed_out') {
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

  function renderFailureAlert(job) {
    const alertEl = document.getElementById('drawer-failure-alert');
    if (job.status === 'failed') {
      alertEl.innerHTML = '<div class="alert fail" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Job failed</div><div class="alert-desc">Failed during execution.</div></div></div>';
    } else if (job.status === 'timed_out') {
      alertEl.innerHTML = '<div class="alert warn" style="margin-bottom:16px"><div class="alert-icon">&#9888;</div><div style="flex:1"><div class="alert-title">Job timed out</div><div class="alert-desc">Workflow exceeded timeout.</div></div></div>';
    } else {
      alertEl.innerHTML = '';
    }
  }

  function renderTimeline(job) {
    const phases = [
      { label: 'Queued', detail: 'queued in Linear' },
      { label: 'Planning', detail: 'claude-plan.yml' },
      { label: 'Implementing', detail: job.executionMode ? window.esc(job.executionMode) + ' run' : 'implementation run' },
      { label: 'Review', detail: job.prUrl ? 'PR opened: #' + (job.prUrl.split('/').pop() || '') : 'awaiting PR' },
      { label: 'Done', detail: 'merged' }
    ];

    let activeIndex = 0;
    const mode = job.executionMode || '';
    if (mode === 'planning') {
      activeIndex = 1;
    } else if (mode === 'fly-machines' || mode === 'github-actions') {
      activeIndex = 2;
      if (job.prUrl) activeIndex = 3;
      if (job.status === 'completed' && job.prUrl) activeIndex = 4;
    } else {
      activeIndex = 0;
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
        if (job.status === 'failed' || job.status === 'timed_out') {
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

  function renderSteps(steps) {
    const stepsEl = document.getElementById('drawer-steps');
    const countEl = document.getElementById('drawer-step-count');
    if (!steps || steps.length === 0) {
      stepsEl.innerHTML = '<div style="font-size:12px;color:var(--fg-tertiary);padding:8px 0">No step records</div>';
      countEl.textContent = 'no step records';
      return;
    }
    countEl.textContent = steps.length + ' step' + (steps.length === 1 ? '' : 's');
    let html = '';
    for (const step of steps) {
      let badgeKind;
      if (step.status === 'running') badgeKind = 'running';
      else if (step.status === 'failed') badgeKind = 'fail';
      else if (step.status === 'completed') badgeKind = 'success';
      else badgeKind = 'neutral';

      const logsLink = step.logsUrl
        ? '<a class="btn btn-sm" href="' + window.esc(step.logsUrl) + '" target="_blank" style="font-size:11px">Logs ↗</a>'
        : '';

      html += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:12.5px">'
        + '<div><span class="mono text-secondary">' + window.esc(step.stepId) + '</span>'
        + ' <span class="text-tertiary" style="margin-left:8px">' + window.esc(step.stepType) + '</span></div>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + logsLink
        + '<span class="badge ' + badgeKind + '"><span class="dot"></span>' + window.esc(step.status) + '</span>'
        + '</div>'
        + '</div>';
    }
    stepsEl.innerHTML = html;
  }

  function renderContext(job, mappings) {
    const contextEl = document.getElementById('drawer-context');
    const fields = [];

    const mapping = mappings && job.teamKey ? mappings[job.teamKey] : null;
    const owner = mapping ? mapping.owner : null;

    if (job.issueIdentifier) {
      fields.push({
        label: 'Linear issue',
        value: '<a class="text-accent" href="https://linear.app/issue/' + window.esc(job.issueIdentifier) + '" target="_blank">' + window.esc(job.issueIdentifier) + ' &#8599;</a>'
      });
    }

    if (job.repo) {
      const repoDisplay = owner ? window.esc(owner) + '/' + window.esc(job.repo) : '?/' + window.esc(job.repo);
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
        value: '<a class="text-accent" href="' + window.esc(job.prUrl) + '" target="_blank">#' + window.esc(prNum) + ' &#8599;</a>'
      });
    }

    let html = '';
    for (const f of fields) {
      html += '<div class="field"><div class="field-label">' + window.esc(f.label) + '</div><div style="font-size:12.5px">' + f.value + '</div></div>';
    }
    contextEl.innerHTML = html;
  }

  function renderLogsLink(job, mappings) {
    const logsLink = document.getElementById('drawer-logs-link');
    const mapping = mappings && job.teamKey ? mappings[job.teamKey] : null;
    const owner = mapping ? mapping.owner : null;
    if (job.runId && owner && job.repo) {
      logsLink.href = 'https://github.com/' + owner + '/' + job.repo + '/actions/runs/' + job.runId;
      logsLink.removeAttribute('hidden');
    } else {
      logsLink.setAttribute('hidden', '');
    }
  }

  function renderDrawer(job, steps, mappings) {
    renderIssueRow(job);
    renderTitle(job);
    renderMeta(job);
    renderElapsed(job, steps);
    renderFailureAlert(job);
    renderTimeline(job);
    renderSteps(steps);
    renderContext(job, mappings);
    renderLogsLink(job, mappings);
  }

  async function openJobDrawer(id) {
    currentJobId = id;
    const wrap = document.getElementById('job-drawer-wrap');
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
    wrap.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';

    let mappings;
    try {
      mappings = await ensureMappings();
    } catch (err) {
      console.error('Failed to load mappings:', err);
      mappings = null;
    }

    let json;
    try {
      const res = await window.api('/api/jobs/' + id + '/steps');
      if (res.status === 404) {
        document.getElementById('drawer-title').textContent = 'Job not found';
        return;
      }
      if (!res.ok) {
        console.error('Failed to load job:', res.status);
        return;
      }
      json = await res.json();
    } catch (err) {
      console.error('Failed to fetch job steps:', err);
      return;
    }

    if (currentJobId !== id) return;

    renderDrawer(json.job, json.steps, mappings);
  }

  function closeJobDrawer() {
    const wrap = document.getElementById('job-drawer-wrap');
    if (wrap) wrap.setAttribute('hidden', '');
    document.body.style.overflow = '';
    currentJobId = null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const wrap = document.getElementById('job-drawer-wrap');
      if (wrap && !wrap.hasAttribute('hidden')) closeJobDrawer();
    }
  });

  window.openJobDrawer = openJobDrawer;
  window.closeJobDrawer = closeJobDrawer;
})();
`;
