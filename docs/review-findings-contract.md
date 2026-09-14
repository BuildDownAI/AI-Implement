# The `review-findings/v1` contract

A reviewer — Claude-based or not — emits its verdict as a single fenced JSON
block at the end of a PR comment. Anything that can post a GitHub PR comment
can emit the contract; nothing about it is Claude-specific. This document is
the reference for that block: its schema, an example, what an emitter must
guarantee, and how a non-Claude reviewer produces one.

The one reviewer that ships in this repo is the composite action at
[`.github/actions/claude-review`](../.github/actions/claude-review/action.yml),
wired into [`.github/workflows/claude-review.yml`](../.github/workflows/claude-review.yml).
Everything below describes the contract that action emits and that any other
emitter must match.

## The block

The comment ends with a fenced code block using the info string
`json review-findings`:

````
```json review-findings
{"schema":"review-findings/v1","verdict":"request_changes","findings":[{"severity":"blocking","title":"...","location":"src/x.ts:42","body":"..."}]}
```
````

- The info string is `json review-findings`, not bare `json` — a gate reading
  a PR's comments looks for that exact string to find the machine block among
  ordinary fenced code the reviewer may also post.
- The JSON is a single line. Nothing about the contract requires that, but it
  removes an entire class of "a stray blank line inside the fence broke the
  parse" failures, and every value inside a JSON string is already safe to put
  on one line.
- `schema` is a literal version tag, `"review-findings/v1"`. It exists so a
  later change to this contract can be *detected* — a consumer that doesn't
  recognise the value should refuse to parse the block rather than guess.

## Schema

The full JSON Schema, also vendored at
[`.github/actions/claude-review/review-findings-schema.json`](../.github/actions/claude-review/review-findings-schema.json)
for use as an `--json-schema` argument:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "summary", "findings"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["approve", "request_changes"]
    },
    "summary": {
      "type": "string"
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "title", "body"],
        "properties": {
          "severity": { "type": "string", "enum": ["blocking", "minor"] },
          "title": { "type": "string", "minLength": 1 },
          "location": { "type": "string" },
          "body": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

Field meanings:

| Field | Meaning |
|---|---|
| `verdict` | Overall merge-readiness call. `request_changes` whenever `findings[]` contains any `severity: "blocking"` entry; `approve` only when it doesn't. |
| `summary` | The reviewer's own free-text summary. Presentation only — carried verbatim into the human-readable part of the comment, never parsed by a gate. |
| `findings[]` | Every issue worth surfacing, blocking or not. Empty when the diff looks fine. |
| `findings[].severity` | `blocking` gates approval; `minor` is surfaced to the human merging but never gates. |
| `findings[].title` | Short label for the finding. |
| `findings[].location` | File, and line or function, when the finding is localised to a spot in the diff. Omitted otherwise. |
| `findings[].body` | Full, self-contained description — a reader must be able to act on it without reading the reviewer's prose above. |

`schema` is not a field the reviewer produces — the emitter stamps it onto
the block itself when it renders the comment, so the version tag can't be
misremembered or omitted by the model or script writing the finding data.
Note that `verdict` and `findings[].severity` are the same shape as
`approved`/`blocking_issues` in `src/pipeline/review-verdict.ts`, which this
repo's *internal* implement-review loop uses — that internal schema is a
separate contract for a separate consumer (the pipeline's own review step,
which reads structured output directly rather than a posted comment) and is
not required to track this one, but the two are intentionally close in shape.

## Full example comment

````markdown
## Claude review

**Verdict:** request_changes

The retry loop looks solid, but the new cache key collides with the existing
per-tenant key when `tenantId` is empty, and there's no test for that path.

### Findings

- **[blocking] Cache key collision on empty tenantId** (src/cache.ts:88): `buildCacheKey` joins `tenantId` and `resourceId` with `:` but doesn't guard against `tenantId === ""`, so a request with no tenant produces the same key as a request for tenant `""` on the same resource — a real value if `tenantId` is ever optional upstream. Reject or namespace the empty case explicitly.
- **[minor] `retryDelayMs` could use the existing backoff helper**: `src/retry.ts` already exports `exponentialBackoff`; this PR reimplements the same formula inline in `fetchWithRetry`. Not blocking, but worth consolidating next time this file is touched.

```json review-findings
{"schema":"review-findings/v1","verdict":"request_changes","findings":[{"severity":"blocking","title":"Cache key collision on empty tenantId","location":"src/cache.ts:88","body":"buildCacheKey joins tenantId and resourceId with ':' but doesn't guard against tenantId === \"\", so a request with no tenant produces the same key as a request for tenant \"\" on the same resource. Reject or namespace the empty case explicitly."},{"severity":"minor","title":"retryDelayMs could use the existing backoff helper","body":"src/retry.ts already exports exponentialBackoff; this PR reimplements the same formula inline in fetchWithRetry."}]}
```
````

## Emitter obligations

Anything that wants to be a valid `review-findings/v1` emitter must:

1. **Post via a normal PR-comment call, from the workflow — not from a
   model's own comment tool.** `.github/actions/claude-review` runs the
   underlying `anthropics/claude-code-action` with no comment-posting tool in
   its `--allowedTools`, gets the verdict back as schema-validated structured
   output, and posts the rendered comment in a separate step with
   `gh pr comment`. That separation is what makes the block trustworthy: the
   text a human reads and the block a machine parses are guaranteed to come
   from the same render, because one step builds both from one JSON value.
2. **Fail the check on no verdict, not produce an empty or partial one.** If
   the reviewer cannot produce a schema-valid result, the check must fail —
   never post a comment with a missing or synthetic block, and never pass
   silently. `.github/actions/claude-review` gets this for free: passing
   `--json-schema` to `claude-code-action` makes the action itself fail (and
   throw) when the model returns no schema-valid `structured_output`, so the
   posting step — which has no `if:` guarding it — never runs.
3. **Post exactly one block per comment, using the exact info string**
   `json review-findings`, valid JSON, matching the schema above.
4. **Version it.** Stamp `"schema":"review-findings/v1"` into the block so a
   later incompatible change is detectable rather than misread as this
   version.

## Emitting it from a non-Claude reviewer (e.g. Codex)

The contract has no dependency on Claude, the Agent SDK, or
`--json-schema` — those are just how `.github/actions/claude-review` happens
to get a schema-validated verdict out of its model. A different reviewer
needs only:

1. Whatever mechanism it already has for producing a verdict and a list of
   findings for a PR.
2. The ability to post a PR comment — `gh pr comment`, the GitHub REST API,
   or any other authenticated path.
3. Discipline about the block: render `{"schema":"review-findings/v1",
   "verdict": ..., "findings": [...]}` as a single line of valid JSON, place
   it in a fence with info string `json review-findings`, and make that fence
   the mechanism the run's success/failure hinges on — if the reviewer has
   nothing to say, that is still a `findings: []` block, not a missing one.

A Codex-based reviewer, for example, could run as its own workflow step,
have its harness write the verdict JSON to a file, and finish with a shell
step that builds the same two-part comment (human-readable body, then the
fenced block) and calls `gh pr comment`. Nothing about `probeExternalReviewCheck`
(`src/pipeline/steps/post-push-review.ts`) cares which reviewer produced the
check run — it matches on the check-run **name**, configurable via
`reviewCheckNames` in `.ai-implement/config.yml` (see the root `CLAUDE.md`).
