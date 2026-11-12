export const setupHtml = `
<section data-page="setup" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Setup</h1>
      <div class="page-subtitle">Read-only checks of this orchestrator's setup, each failing one with its fix</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadSetup()">&#8635; Refresh</button>
      <button class="btn btn-accent btn-sm" id="setup-run-btn" onclick="startSetupRun()" hidden>Run checks</button>
    </div>
  </header>
  <div class="page-body">
    <div id="setup-error" class="error hidden"></div>

    <div id="setup-unreadable" class="alert fail" hidden>
      <span class="alert-icon">!</span>
      <div>
        <div class="alert-title">Setup checks cannot be read right now</div>
        <div class="alert-desc">This orchestrator's Restate engine is not serving, so the last run cannot be read and a new run cannot start. The setup command runs every check without Restate, and its restate row says what is wrong.</div>
        <div class="alert-desc" id="setup-command-line" hidden style="margin-top:6px">Run it with <span class="mono" id="setup-command" style="user-select:all"></span></div>
      </div>
    </div>

    <div id="setup-never-run" hidden style="text-align:center;padding:24px 0">
      <div style="display:inline-flex;flex-direction:column;align-items:center;gap:8px">
        <button class="btn btn-accent btn-lg" id="setup-run-first-btn" onclick="startSetupRun()">Run checks</button>
        <div class="kpi-trend text-secondary" id="setup-never-run-hint" style="justify-content:center;max-width:46ch"></div>
      </div>
    </div>

    <div class="kpi-grid" id="setup-kpis" style="grid-template-columns:repeat(auto-fit, minmax(200px, 1fr))" hidden>
      <div class="kpi">
        <div class="kpi-label"><span id="setup-run-label">Last run</span> <span class="badge neutral" id="setup-run-badge">&#8212;</span></div>
        <div class="kpi-value" style="white-space:nowrap"><span id="setup-run-value">&#8212;</span><span class="kpi-unit" id="setup-run-unit"></span></div>
      </div>
      <div class="kpi"><div class="kpi-label">Failing</div><div class="kpi-value" id="setup-kpi-fail">0</div></div>
      <div class="kpi"><div class="kpi-label">Warnings</div><div class="kpi-value" id="setup-kpi-warn">0</div></div>
      <div class="kpi"><div class="kpi-label">Cannot verify</div><div class="kpi-value" id="setup-kpi-cannot-verify">0</div></div>
      <div class="kpi"><div class="kpi-label">Passing</div><div class="kpi-value" id="setup-kpi-pass">0</div></div>
    </div>

    <div id="setup-groups" style="display:flex;flex-direction:column;gap:24px"></div>
  </div>
</section>
`;

export const setupScript = `
(function () {
  // While a run is going the page polls as the job drawer does for a running job, otherwise as Blockers does.
  var RUNNING_POLL_MS = 5000;
  var IDLE_POLL_MS = 60000;
  // A started run reaches its handler a moment after the start is answered, so the page waits this long for it.
  var START_WAIT_MS = 30000;
  // How many running checks a card names before counting the rest.
  var RUNNING_NAMED = 3;

  // The states listed open in each table, worst first; the rest fold away.
  var ACTIONABLE = ['fail', 'cannot-verify', 'warn'];
  var STATE_BADGE = {
    'fail': ['fail', 'Fail'],
    'cannot-verify': ['info', 'Cannot verify'],
    'warn': ['warn', 'Warning'],
    'pass': ['success', 'Pass'],
    'not-applicable': ['neutral', 'Not applicable']
  };

  // What each card covers, under its name. Only this page says it, so it lives here rather than coming from the route.
  var GROUP_CONTEXT = {
    'orchestrator': "This orchestrator's environment, saved settings, sign-in, database and Restate engine, and the address runs report to",
    'tracker': 'The ticketing systems the projects use, and how this orchestrator reaches each',
    'github': 'The GitHub App this orchestrator acts as, its webhooks and its knowledge graph access',
    'model': 'The model accounts runs use'
  };
  var PROJECT_CONTEXT = "This project's ticketing system setup and its GitHub repository";

  // pendingStart is set by a started run until the run shows up: the stored run it must replace, and when it began.
  var state = { data: null, unreadable: false, setupCommand: null, pendingStart: null };
  // Which tables' passing rows are unfolded, by table key, so a refresh keeps them open.
  var unfolded = {};
  var pollTimer = null;
  var tickTimer = null;
  // Counts loads, so an older load answering after a newer one never replaces what the newer one showed.
  var loadSeq = 0;

  /** Which view the page shows: 'loading', 'unreadable', 'never-run', 'running' or 'ran'. */
  function view() {
    if (state.unreadable) return 'unreadable';
    if (!state.data) return 'loading';
    if (state.data.progress || state.pendingStart) return 'running';
    if (!state.data.run) return 'never-run';
    return 'ran';
  }

  function countBy(rows) {
    var counts = { 'fail': 0, 'cannot-verify': 0, 'warn': 0, 'pass': 0, 'not-applicable': 0 };
    rows.forEach(function (row) { counts[row.state] = (counts[row.state] || 0) + 1; });
    return counts;
  }

  function shownRows() {
    if (view() === 'ran') return state.data.run.results;
    return state.data.progress ? state.data.progress.finished : [];
  }

  function renderKpis(rows) {
    var counts = countBy(rows);
    ['fail', 'warn', 'cannot-verify', 'pass'].forEach(function (s) {
      document.getElementById('setup-kpi-' + s).textContent = String(counts[s]);
    });
  }

  function renderRunTile() {
    var badge = document.getElementById('setup-run-badge');
    var label = document.getElementById('setup-run-label');
    var value = document.getElementById('setup-run-value');
    var unit = document.getElementById('setup-run-unit');
    var progress = state.data.progress;
    value.title = '';
    if (view() === 'running') {
      label.textContent = 'This run';
      window.setStatusBadge(badge, 'running', 'Running');
      if (progress) {
        value.textContent = (progress.total - progress.running.length) + ' of ' + progress.total;
        unit.textContent = window.fmtDuration(Date.now() - progress.startedAt);
        value.title = 'Checks finished, and time since the run began';
      } else {
        value.textContent = 'Starting';
        unit.textContent = '';
      }
      return;
    }
    var run = state.data.run;
    var counts = countBy(run.results);
    label.textContent = 'Last run';
    if (counts['fail']) window.setStatusBadge(badge, 'fail', 'Failing');
    else if (counts['warn'] || counts['cannot-verify']) window.setStatusBadge(badge, 'warn', 'Needs attention');
    else window.setStatusBadge(badge, 'success', 'Passing');
    value.textContent = window.fmtAgo(run.checkedAt);
    value.title = new Date(run.checkedAt).toLocaleString();
    unit.textContent = run.startedAt ? 'took ' + window.fmtDuration(run.checkedAt - run.startedAt) : '';
  }

  /** Worst state first, then in the route's group order; the run's own order breaks ties. */
  function openRows(rows) {
    var groups = Object.keys(state.data.groups);
    return rows.filter(function (row) { return ACTIONABLE.indexOf(row.state) !== -1; }).sort(function (a, b) {
      return ACTIONABLE.indexOf(a.state) - ACTIONABLE.indexOf(b.state) || groups.indexOf(a.group) - groups.indexOf(b.group);
    });
  }

  function cell(content, className) {
    return '<td' + (className ? ' class="' + className + '"' : '') + '>' + content + '</td>';
  }

  // The id under the title is what fixes and the setup command name a check by.
  function checkCell(title, id) {
    return cell('<div>' + window.esc(title) + '</div><div class="mono text-secondary" style="font-size:11px;margin-top:2px;overflow-wrap:anywhere">' + window.esc(id) + '</div>');
  }

  function fixCell(row) {
    if (!row.fix) return cell('');
    return cell(window.esc(row.fix)
      + (row.fixUrl ? ' <a class="text-accent" href="' + window.escAttr(window.safeUrl(row.fixUrl)) + '" target="_blank" rel="noopener">Open ↗</a>' : ''));
  }

  function rowHtml(row, hidden) {
    var badge = STATE_BADGE[row.state] || ['neutral', row.state];
    return '<tr' + (hidden ? ' hidden' : '') + '>' + checkCell(row.title, row.id)
      + cell(window.statusBadge(badge[0], badge[1]))
      + cell(window.esc(row.detail || ''), 'text-secondary') + fixCell(row) + '</tr>';
  }

  // The checks still running, in one line so a run in progress does not lengthen the page.
  // The first few are named, in the list's own order, and the rest counted.
  function runningLine(running) {
    if (!running.length) return '';
    var names = running.slice(0, RUNNING_NAMED).map(function (check) { return window.esc(check.title); }).join(', ');
    var rest = running.length - RUNNING_NAMED;
    return window.statusBadge('running', running.length + ' running') + ' <span class="text-secondary">'
      + names + (rest > 0 ? ', and ' + rest + ' more' : '') + '</span>';
  }

  function foldLabel(counts) {
    var parts = [];
    if (counts['pass']) parts.push(counts['pass'] + ' passing');
    if (counts['not-applicable']) parts.push(counts['not-applicable'] + ' not applicable');
    return parts.join(', ');
  }

  // Fixed widths, the same in every card, so opening a fold never moves a column and the cards line up.
  // Below its minimum width the table scrolls sideways inside its card rather than squeezing its text.
  function table(body) {
    return '<table class="tbl" style="table-layout:fixed;min-width:900px">'
      + '<colgroup><col style="width:24%"><col style="width:11%"><col style="width:35%"><col style="width:30%"></colgroup>'
      + '<thead><tr><th>Check</th><th>State</th><th>What was found</th><th>Fix</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  // One card's checks: the open rows, the line of running checks, then a fold over the rest.
  // Folded rows stay in the same table as the open rows, so their columns line up.
  // With nothing open, the running line and the fold sit above the table, so opening the fold adds the table below and the fold stays put.
  function checksBody(key, rows, running, folds) {
    var open = openRows(rows);
    var folded = rows.filter(function (row) { return ACTIONABLE.indexOf(row.state) === -1; });
    var unfold = folded.length > 0 && !!unfolded[key];
    if (folded.length) folds.push(key);
    var fold = folded.length
      ? '<button type="button" class="btn btn-ghost btn-sm text-accent setup-fold">'
        + '<span style="display:inline-block;transform:rotate(' + (unfold ? 90 : 0) + 'deg)">›</span> ' + window.esc(foldLabel(countBy(rows))) + '</button>'
      : '';
    var foldedRows = folded.map(function (row) { return rowHtml(row, !unfold); }).join('');
    var runningNow = runningLine(running);
    if (!open.length) {
      return (runningNow ? '<div class="setup-running-row" style="padding:10px 14px">' + runningNow + '</div>' : '')
        + (fold ? '<div class="setup-fold-row" style="padding:10px 14px">' + fold + '</div>' : '')
        + (unfold ? table(foldedRows) : '');
    }
    return table(open.map(function (row) { return rowHtml(row, false); }).join('')
      + (runningNow ? '<tr class="setup-running-row"><td colspan="4">' + runningNow + '</td></tr>' : '')
      + (fold ? '<tr class="setup-fold-row"><td colspan="4">' + fold + '</td></tr>' + foldedRows : ''));
  }

  function card(title, subtitle, body) {
    return '<div class="card"><div class="card-header"><div><h2 class="card-title">' + window.esc(title) + '</h2>'
      + (subtitle ? '<div class="card-subtitle">' + window.esc(subtitle) + '</div>' : '') + '</div></div>'
      + '<div class="card-body tight">' + body + '</div></div>';
  }

  // A card per group for the checks that run once for the orchestrator, then a card per project for the rest.
  function renderGroups(rows) {
    var running = view() === 'running' && state.data.progress ? state.data.progress.running : [];
    var inGroup = function (group) { return function (item) { return item.group === group; }; };
    var wide = rows.filter(function (row) { return !row.project; });
    var perProject = rows.filter(function (row) { return row.project; });
    var folds = [];
    // Group order and names come from the route, as do the names of checks still running.
    var groups = Object.keys(state.data.groups);
    var html = groups.filter(function (group) { return wide.some(inGroup(group)) || running.some(inGroup(group)); })
      .map(function (group) {
        return card(state.data.groups[group], GROUP_CONTEXT[group] || '', checksBody(group, wide.filter(inGroup(group)), running.filter(inGroup(group)), folds));
      }).join('');
    var projects = [];
    perProject.forEach(function (row) { if (projects.indexOf(row.project) === -1) projects.push(row.project); });
    html += projects.sort().map(function (project) {
      var own = perProject.filter(function (row) { return row.project === project; });
      return card(project, PROJECT_CONTEXT, checksBody('project:' + project, own, [], folds));
    }).join('');
    var el = document.getElementById('setup-groups');
    el.innerHTML = html;
    // Each fold's key is captured here rather than written into the markup (ADR 002).
    el.querySelectorAll('.setup-fold').forEach(function (button, i) {
      button.addEventListener('click', function () {
        unfolded[folds[i]] = !unfolded[folds[i]];
        renderGroups(shownRows());
      });
    });
  }

  function render() {
    var v = view();
    var admin = window.isAdmin();
    var showsRun = v === 'running' || v === 'ran';
    document.getElementById('setup-unreadable').hidden = v !== 'unreadable';
    // The route names the command for where this orchestrator runs; the page has no other way to know it.
    document.getElementById('setup-command').textContent = state.setupCommand || '';
    document.getElementById('setup-command-line').hidden = !state.setupCommand;
    document.getElementById('setup-never-run').hidden = v !== 'never-run';
    document.getElementById('setup-kpis').hidden = !showsRun;
    var runBtn = document.getElementById('setup-run-btn');
    runBtn.hidden = !admin || !showsRun;
    runBtn.disabled = v === 'running';
    runBtn.textContent = v === 'running' ? 'Running…' : 'Run checks';
    document.getElementById('setup-run-first-btn').hidden = !admin;
    document.getElementById('setup-never-run-hint').textContent = admin
      ? 'No run has happened yet. Each check only reads, so a run changes nothing on this orchestrator or the services it uses.'
      : 'No run has happened to show anything here yet. Only an admin can start one.';
    if (showsRun) {
      var rows = shownRows();
      renderKpis(rows);
      renderRunTile();
      renderGroups(rows);
    } else {
      document.getElementById('setup-groups').innerHTML = '';
    }
    // The elapsed time counts up between polls; nothing is fetched for it.
    clearInterval(tickTimer);
    if (v === 'running' && state.data.progress) tickTimer = setInterval(renderRunTile, 1000);
  }

  function showError(message) {
    var el = document.getElementById('setup-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function apply(payload, unreadable, setupCommand) {
    state.unreadable = unreadable;
    state.setupCommand = setupCommand;
    state.data = payload;
    var pending = state.pendingStart;
    if (pending && payload) {
      var run = payload.run;
      if (payload.progress || (run && run.checkedAt !== pending.after) || Date.now() - pending.at > START_WAIT_MS) state.pendingStart = null;
    }
    render();
  }

  async function loadSetup() {
    clearTimeout(pollTimer);
    var seq = ++loadSeq;
    var payload = null;
    var unreadable = false;
    var setupCommand = null;
    var failure = '';
    try {
      var res = await window.api('/api/setup-checks');
      if (res.status === 503) {
        unreadable = true;
        var refused = await res.json().catch(function () { return null; });
        setupCommand = refused && refused.setupCommand || null;
      } else if (res.ok) payload = await res.json();
      else failure = 'Setup checks could not be loaded (HTTP ' + res.status + ').';
    } catch (e) {
      failure = 'Setup checks could not be loaded.';
    }
    // A newer load began meanwhile, and it owns what the page shows and when it polls next.
    if (seq !== loadSeq) return;
    if (failure) showError(failure);
    // Outside the catch deliberately: a render fault is a bug, and reporting it as a failed request misleads.
    if (payload || unreadable) {
      showError('');
      apply(payload, unreadable, setupCommand);
    }
    pollTimer = setTimeout(loadSetup, view() === 'running' ? RUNNING_POLL_MS : IDLE_POLL_MS);
  }
  window.loadSetup = loadSetup;

  async function startSetupRun() {
    showError('');
    var res;
    try {
      res = await window.api('/api/setup-checks/run', { method: 'POST' });
    } catch (e) {
      return showError('The run could not be started.');
    }
    if (res.status === 202) {
      var run = state.data && state.data.run;
      state.pendingStart = { after: run ? run.checkedAt : null, at: Date.now() };
    } else if (res.status !== 409) {
      return showError(res.status === 503
        ? 'A run cannot start right now, because the Restate engine is not serving.'
        : 'The run could not be started (HTTP ' + res.status + ').');
    }
    // A 409 means a run is already going, so the page simply shows it.
    return loadSetup();
  }
  window.startSetupRun = startSetupRun;

  window.registerPage('setup', function () { loadSetup(); });
})();
`;
