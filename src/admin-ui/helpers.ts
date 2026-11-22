// Rendering helpers every admin page shares, as their own script block ahead of auth.ts:
// - escaping: esc(), escAttr(), safeUrl(), raw(), html
// - badges: statusBadge(), setStatusBadge(), labelBadge()
// - time: fmtAgo(), fmtDuration()
export const helpersJs = `
(function () {
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }
  window.esc = esc;

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
  window.escAttr = escAttr;

  // Validates URL scheme; returns '#' for javascript:, data:, etc.
  // Relative URLs (/path, ./path, #fragment) and http/https/mailto pass through.
  function safeUrl(s) {
    if (s == null) return '#';
    const str = String(s);
    if (!str) return '';
    if (str[0] === '#' || str[0] === '/' || str[0] === '.' || !str.includes(':')) return str;
    try {
      const url = new URL(str);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return str;
    } catch (_) { /* malformed URL with colon — block it */ }
    return '#';
  }
  window.safeUrl = safeUrl;

  function raw(s) {
    return { __raw: true, value: String(s == null ? '' : s) };
  }
  window.raw = raw;

  // Tagged template that escapes every interpolation with escAttr() by default.
  // For href/src attributes, also validates the URL scheme via safeUrl().
  // Wrap a value with raw() to inject pre-built markup without escaping.
  // Residual: does not detect URL context when the attribute is split across
  // multiple interpolations or the URL is built in a variable before the template.
  function html(strings, ...values) {
    let result = '';
    for (let i = 0; i < strings.length; i++) {
      result += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (v && typeof v === 'object' && v.__raw) {
          result += v.value;
        } else {
          // The backslashes are doubled: this template literal drops a single one, leaving a literal s.
          const inUrlAttr = /(?:href|src)\\s*=\\s*["']?$/i.test(strings[i]);
          result += escAttr(inUrlAttr ? safeUrl(v) : v);
        }
      }
    }
    return result;
  }
  window.html = html;

  // A dot marks a state: a badge that reports a result or a condition someone may act on, and that can
  // move to another state, including clearing once it is acted on. .badge.<kind> .dot colors the dot and
  // .badge.running .dot pulses it, so a status badge written without the dot loses both silently.
  function statusBadge(kind, label) {
    return '<span class="badge ' + escAttr(kind) + '"><span class="dot"></span>' + esc(label) + '</span>';
  }
  window.statusBadge = statusBadge;

  // The same badge written into an element already on the page, for a badge whose state changes in place.
  function setStatusBadge(el, kind, label) {
    el.className = 'badge ' + kind;
    el.innerHTML = '<span class="dot"></span>' + esc(label);
  }
  window.setStatusBadge = setStatusBadge;

  // A label: a value that never changes for what it describes, or moves only from one label to another,
  // such as a runner kind, a step's origin, a category or a retry count. It carries no dot.
  function labelBadge(kind, label) {
    return '<span class="badge ' + escAttr(kind) + '">' + esc(label) + '</span>';
  }
  window.labelBadge = labelBadge;

  // How long ago a time was, from epoch milliseconds or an ISO string. It rolls over into days,
  // since a quiet orchestrator's last event is often weeks old and "504h ago" is unreadable.
  function fmtAgo(time) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(time).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  window.fmtAgo = fmtAgo;

  // A length of time in milliseconds. For something still running, pass the time since it started,
  // since fmtAgo's "ago" reads wrong there. A negative length, from a clock that moved back, reads 0s.
  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  window.fmtDuration = fmtDuration;

  // Setup-check states, worst first, which every setup surface orders rows by. The first three need attention,
  // so a page shows their rows open and folds the rest, and a marker takes the worst of them.
  const SETUP_STATE_ORDER = ['fail', 'cannot-verify', 'warn', 'pass', 'not-applicable'];
  const SETUP_ACTIONABLE = SETUP_STATE_ORDER.slice(0, 3);
  window.SETUP_STATE_ORDER = SETUP_STATE_ORDER;
  window.SETUP_ACTIONABLE = SETUP_ACTIONABLE;

  // A setup check's row, as the Setup page and the New project stepper show it: the check and its id,
  // its state, what was found, and its fix with any page that applies it.
  const SETUP_STATE_BADGE = {
    'fail': ['fail', 'Fail'],
    'cannot-verify': ['info', 'Cannot verify'],
    'warn': ['warn', 'Warning'],
    'pass': ['success', 'Pass'],
    'not-applicable': ['neutral', 'Not applicable']
  };

  function setupCell(content, className) {
    return '<td' + (className ? ' class="' + className + '"' : '') + '>' + content + '</td>';
  }

  // The id under the title is what fixes and the setup command name a check by.
  function setupCheckCell(title, id) {
    return setupCell('<div>' + esc(title) + '</div><div class="mono text-secondary" style="font-size:11px;margin-top:2px;overflow-wrap:anywhere">' + esc(id) + '</div>');
  }

  function setupFixText(row) {
    return esc(row.fix) + (row.fixUrl ? ' <a class="text-accent" href="' + escAttr(safeUrl(row.fixUrl)) + '" target="_blank" rel="noopener">Open ↗</a>' : '');
  }

  function setupFixCell(row) {
    return setupCell(row.fix ? setupFixText(row) : '');
  }

  // The same row stacked for a narrow container, as the New project stepper shows it: the check and its state on one line,
  // what was found and the fix beneath. Its spacing and colors are the .setup-check-item rules, so a container can restyle it.
  // shaded marks every other item of a list, counted by the caller so rows a fold hides still keep the alternation.
  function setupCheckItem(row, hidden, shaded) {
    const badge = SETUP_STATE_BADGE[row.state] || ['neutral', row.state];
    return '<div class="setup-check-item' + (shaded ? ' shaded' : '') + '"' + (hidden ? ' hidden' : '') + '>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">'
      + '<div style="min-width:0"><div class="setup-check-title">' + esc(row.title) + '</div><div class="mono setup-check-id">' + esc(row.id) + '</div></div>'
      + '<div style="flex-shrink:0">' + statusBadge(badge[0], badge[1]) + '</div></div>'
      + (row.detail ? '<div class="setup-check-line"><span class="setup-check-label">Found</span><span>' + esc(row.detail) + '</span></div>' : '')
      + (row.fix ? '<div class="setup-check-line"><span class="setup-check-label">Fix</span><span>' + setupFixText(row) + '</span></div>' : '')
      + '</div>';
  }
  window.setupCheckItem = setupCheckItem;

  // Rows of one project that wait on the same check say only that it comes first, so two or more show as one row naming them all,
  // in the place of the first of them. Every other row stays as it is and where it is. For showing only: counts and verdicts read the rows themselves.
  // The setup command prints them the same way (joinWaitingRows).
  function groupWaitingRows(rows) {
    const keyOf = function (row) { return row.waitsOn ? (row.project || '') + '|' + row.waitsOn : null; };
    const waiting = {};
    rows.forEach(function (row) { const key = keyOf(row); if (key) (waiting[key] = waiting[key] || []).push(row); });
    const shown = [];
    rows.forEach(function (row) {
      const group = keyOf(row) ? waiting[keyOf(row)] : null;
      if (!group || group.length < 2) { shown.push(row); return; }
      if (group[0] !== row) return;
      const sameDetail = group.every(function (each) { return each.detail === row.detail; });
      shown.push({
        title: group.length + ' checks wait on ' + row.waitsOn,
        id: group.map(function (each) { return each.id; }).join(', '),
        state: row.state,
        detail: sameDetail ? row.detail : 'None of them can be read until ' + row.waitsOn + ' passes.',
        fix: row.fix,
      });
    });
    return shown;
  }
  window.groupWaitingRows = groupWaitingRows;

  // The verdict a marker shows for a set of setup-check rows: the worst state among those that can be judged, one row being enough to set it.
  // Rows that do not apply, and checks that can never be verified, are left out. Null when none is left to judge.
  function setupVerdict(rows) {
    const judged = rows.filter(function (row) { return row.verifiable !== false && row.state !== 'not-applicable'; });
    if (!judged.length) return null;
    const worst = SETUP_STATE_ORDER.find(function (state) { return judged.some(function (row) { return row.state === state; }); });
    const badge = SETUP_STATE_BADGE[worst] || SETUP_STATE_BADGE['pass'];
    return { kind: badge[0], label: badge[1], toLook: judged.filter(function (row) { return row.state !== 'pass'; }).length };
  }
  window.setupVerdict = setupVerdict;

  function setupCheckRow(row, hidden) {
    const badge = SETUP_STATE_BADGE[row.state] || ['neutral', row.state];
    return '<tr' + (hidden ? ' hidden' : '') + '>' + setupCheckCell(row.title, row.id)
      + setupCell(statusBadge(badge[0], badge[1]))
      + setupCell(esc(row.detail || ''), 'text-secondary') + setupFixCell(row) + '</tr>';
  }
  window.setupCheckRow = setupCheckRow;

  // Fixed widths, the same in every table, so opening a fold never moves a column and tables line up.
  // Below its minimum width the table scrolls sideways inside its container rather than squeezing its text.
  function setupCheckTable(body) {
    return '<table class="tbl" style="table-layout:fixed;min-width:900px">'
      + '<colgroup><col style="width:24%"><col style="width:11%"><col style="width:35%"><col style="width:30%"></colgroup>'
      + '<thead><tr><th>Check</th><th>State</th><th>What was found</th><th>Fix</th></tr></thead><tbody>' + body + '</tbody></table>';
  }
  window.setupCheckTable = setupCheckTable;

  // A GitHub repository as an operator types or pastes it: owner/repo, a github.com address, a trailing .git or slash,
  // and surrounding whitespace. Null unless exactly two parts remain, neither empty nor holding whitespace.
  function splitGithubRepo(raw) {
    let v = String(raw == null ? '' : raw).trim();
    v = v.replace(/^https?:\\/\\/(?:www\\.)?github\\.com\\//i, '').replace(/\\/+$/, '').replace(/\\.git$/i, '').replace(/^\\/+/, '');
    const parts = v.split('/');
    if (parts.length !== 2) return null;
    const owner = parts[0].trim();
    const repo = parts[1].trim();
    if (!owner || !repo || /\\s/.test(owner + repo)) return null;
    return { owner: owner, repo: repo };
  }
  window.splitGithubRepo = splitGithubRepo;

  // The warning for a JQL clause on a field the orchestrator handles itself, the AI-Implement Status or Repo field,
  // named by its name or by its override's ID (written customfield_N or cf[N]). Null when the JQL has none.
  function jqlScopeWarning(jql, fields) {
    const text = String(jql || '');
    function namesId(id) {
      const clean = String(id || '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!clean) return false;
      const custom = /^customfield_(\\d+)$/.exec(clean);
      return new RegExp('\\\\b' + clean + '\\\\b').test(text) || (custom !== null && text.toLowerCase().indexOf('cf[' + custom[1] + ']') !== -1);
    }
    if (/ai[\\s\\-_]?implement[\\s\\-_]?status/i.test(text)) {
      return 'The JQL names the AI-Implement Status field. '
        + 'The orchestrator adds its own status clause when it searches, so a status clause here stops issues being picked up after their status changes (Plan Approved → Implementing). '
        + 'Remove the status clause.';
    }
    if (fields && namesId(fields.statusField)) {
      return 'The JQL names ' + fields.statusField + ', your status field. '
        + 'The orchestrator adds its own status clause when it searches, so remove the status clause here.';
    }
    if (/ai[\\s\\-_]?implement[\\s\\-_]?repo/i.test(text) || (fields && namesId(fields.repoField))) {
      return 'The JQL names the AI-Implement Repo field. '
        + "The orchestrator matches each issue's repo field itself, so this project does not need a repo clause, and an = clause can drop issues when the field is a text field.";
    }
    return null;
  }
  window.jqlScopeWarning = jqlScopeWarning;
})();
`;
