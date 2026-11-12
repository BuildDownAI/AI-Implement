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
})();
`;
