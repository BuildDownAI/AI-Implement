# ADR 002: Admin SPA HTML escaping — safe-by-construction helpers

**Status:** Accepted

**Date:** 2026-08-14

**References:** AII-385 (site survey and implementation), AII-391 (prior bug in reports page that motivated the audit)

---

## Context

The admin SPA builds all its markup by string concatenation with no build step (no JSX, no framework, no template compiler). Escaping is entirely a matter of author discipline at every call site.

`window.esc()` is the only escaper that existed before this ADR. It serialises a value via a DOM text node (`div.textContent = s; return div.innerHTML`) and is correct for **text content** — but wrong in two other contexts:

1. **Quoted HTML attributes** (`title=`, `value=`, `data-*`): `esc()` does not escape `"` or `'`. A value containing a double-quote breaks out of the attribute.
2. **`href`/`src` with an externally-sourced URL**: the scheme comes from data. A value of `javascript:alert(1)` contains no `<`, `>`, `&`, `"`, or `'` and passes `esc()` completely untouched, yet executes on click.

A site survey (against the `testing` branch, post-AII-391) identified 23 call sites where `esc()` was used in an attribute context:

- **Tier 1a (5 sites):** `data-*` attributes feeding `this.dataset.X` in inline `onclick` handlers — value serialised into HTML and then re-read by JS.
- **Tier 1b (8 sites):** `title=`, `value=`, `alt=`, `placeholder=` — quote-escaping sufficient.
- **Tier 2a (10 sites):** `href`/`src` where the whole URL (including scheme) comes from data — quote-escaping insufficient.
- **Tier 2b (5 sites):** `href` with a static `https://` prefix and only a path segment from data — quote-escaping sufficient.

None of these sites is currently attacker-controlled. The risk is that a future author copies a pattern, adds a tracker-supplied URL, and assumes `esc()` covers it.

---

## Decision

Introduce three helpers alongside `esc()` in `auth.ts` (the script block shared by every admin page):

### `escAttr(s)`

Escapes `&`, `<`, `>`, `"`, and `'` using HTML entity encoding — no DOM round-trip required. Use for any value placed in a quoted HTML attribute (`title=`, `value=`, data attributes, path segments inside `href=`).

### `safeUrl(s)`

Validates the scheme before allowing a value into an `href` or `src` where the whole URL comes from data. Returns the original string for `http:`, `https:`, `mailto:`, relative paths, and fragment references. Returns `'#'` for everything else. Escaping cannot provide this guarantee — `javascript:alert(1)` contains no quotable character.

### `html` tagged template

A tagged template function that calls `escAttr()` on every interpolation by default. When the preceding static chunk ends with `href=`, `href="`, `src=`, or `src="` (case-insensitive), it additionally routes the value through `safeUrl()` before `escAttr()`, blocking `javascript:` and other dangerous schemes. An explicit `raw(markup)` wrapper passes pre-built HTML through unescaped (the equivalent of `dangerouslySetInnerHTML` in React).

**Residual case:** the detection inspects only the static chunk immediately before the interpolation. It does not detect URL context when the attribute name and the URL are spread across multiple interpolations, or when the URL is assembled in a variable before entering the template. In those cases, call `safeUrl()` explicitly before passing the value to `html`.

### Removal of `data-*` + inline `onclick`

Where a value was serialised into a `data-*` attribute and then read back by an inline `onclick` handler via `this.dataset.X`, the attribute is removed entirely and an `addEventListener` closure captures the value directly. The value is never serialised into HTML at all, eliminating the question of whether escaping is correct.

---

## Consequences

**Positive:**
- Every HTML generation path now has a named helper that matches its security context: `esc()` for text, `escAttr()` for attributes, `safeUrl()` for full URLs.
- The `html` tagged template makes the safe path the lazy path for new code: `href` and `src` interpolations are scheme-validated automatically; other attribute and text interpolations are HTML-escaped; only pre-built markup requires an explicit `raw()` opt-out.
- Removing the `data-*` + inline handler pattern eliminates a class of issues rather than mitigating them.
- The ADR documents the three-way distinction once; `CLAUDE.md` propagates it to every future session.

**Negative / trade-offs:**
- 154 existing call sites still use `esc()` for text-node content, which is correct but looks identical to the wrong usage. The tagged template is the long-term answer; bulk conversion would be churn without safety benefit today.
- `safeUrl()` validates scheme but does not HTML-encode the URL contents (e.g., an `&` in a query string). When used inside `html`, `escAttr()` encodes the result, so `&` in a query string becomes `&amp;`; this is correct per the HTML spec for attribute values. Manual call sites that use `safeUrl()` directly (outside `html`) do not encode, which is acceptable because all Tier 2a URLs originate from trusted sources — none of which contain raw quotes or injection-relevant characters.
- The `html` template does not detect URL context when the attribute name and the URL span multiple interpolations, or when the URL is built in a variable before the template call. Those cases require an explicit `safeUrl()` before the value enters the template.

---

## Alternatives considered

### A single `esc()` that also escapes `"` and `'`

Adding quote-escaping to the existing `esc()` would fix Tier 1 and Tier 2b sites in one change. Rejected for two reasons: (1) callers that feed `esc()` output into a JavaScript string or JSON payload (rather than HTML) would receive `&quot;` literally, which is wrong; introducing `escAttr()` as a new function avoids this. (2) Quote-escaping still cannot fix Tier 2a — `javascript:alert(1)` passes any escaper.

### `safeUrl()` that also HTML-escapes the result

Returning `escAttr(safeUrl(url))` from every Tier 2a site would be more defensive. Rejected because all Tier 2a URLs are orchestrator- or GitHub-generated and would double-encode legitimate `&` characters in query strings (`&amp;` in an `href` is technically required but most browsers tolerate bare `&`; the encoding change would be noise and a test-maintenance burden for no practical security gain).

### Converting the SPA to a framework (React, Lit, etc.)

A compiled template layer with automatic context-aware escaping would eliminate the discipline problem entirely. Rejected: it requires a build step that the SPA deliberately avoids, a significant migration effort against 154 call sites and every page module, and ongoing build tooling maintenance. The tagged template achieves 80% of the safety benefit with 1% of the cost, for new code only.
