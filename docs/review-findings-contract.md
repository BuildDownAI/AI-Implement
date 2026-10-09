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
{"schema":"review-findings/v1","verdict":"changes_requested","findings":[{"severity":"blocking","path":"src/x.ts","line":42,"body":"..."}]}
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

## Wire Schema

This is the schema for the fenced block that consumers parse from a PR
comment:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "verdict", "findings"],
  "properties": {
    "schema": {
      "type": "string",
      "const": "review-findings/v1"
    },
    "verdict": {
      "type": "string",
      "enum": ["approve", "changes_requested", "incomplete"]
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "body"],
        "properties": {
          "severity": { "type": "string", "enum": ["blocking", "minor"] },
          "path": { "type": "string" },
          "line": { "type": "integer" },
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
| `schema` | Literal version tag. Consumers reject any value other than `review-findings/v1`. |
| `verdict` | Overall merge-readiness call: `approve`, `changes_requested`, or `incomplete`. |
| `findings[]` | Every issue worth surfacing, blocking or not. Empty when the diff looks fine. |
| `findings[].severity` | Human-facing severity label. Consumer project policy decides how findings affect gating. |
| `findings[].path` | File path when the finding is localised to a file in the diff. Omitted otherwise. |
| `findings[].line` | One-based line number when the finding is localised to a line in the diff. Omitted otherwise. |
| `findings[].body` | Full, self-contained description — a reader must be able to act on it without reading the reviewer's prose above. |

`.github/actions/claude-review` asks Claude for a nearby but different
structured output shape: it includes `summary`, which is used only for the
human-readable prose above the fenced block, and it omits `schema`, which the
trusted render step stamps onto the block. That model-facing schema is vendored
at
[`.github/actions/claude-review/review-findings-schema.json`](../.github/actions/claude-review/review-findings-schema.json)
and passed to Claude as a compact JSON literal via `--json-schema`.

Claude returns the review by calling a structured-output tool whose arguments are `verdict`, `findings` and `summary`. Claude Code checks those arguments against the schema only after the call is made. When they do not match, Claude is told why and tries again; when every retry fails, the check fails with `error_max_structured_output_retries` and no review is posted.

One way a call fails is by losing an argument. Claude writes the arguments in roughly the order the schema lists them, and `summary` is a long free-text review full of Markdown. When Claude does not end the `summary` argument cleanly, the argument it writes next ends up as text inside `summary`, and the call arrives without that argument.

So the schema lists `verdict`, then `findings`, then `summary` last. Both short arguments are complete before the long text starts, and if the end of `summary` goes wrong there is no argument after it to lose; at worst, stray text ends up at the end of the summary itself. This lowers how often the call fails but does not rule it out, because Claude Code does not enforce the order.

The schema's descriptions are stripped before it reaches Claude, so the action's prompt is where a finding's fields are described.

## Full example comment

````markdown
## Claude review

**Verdict:** changes_requested

The retry loop looks solid, but the new cache key collides with the existing
per-tenant key when `tenantId` is empty, and there's no test for that path.

### Findings

- **[blocking]** (src/cache.ts:88): `buildCacheKey` joins `tenantId` and `resourceId` with `:` but doesn't guard against `tenantId === ""`, so a request with no tenant produces the same key as a request for tenant `""` on the same resource — a real value if `tenantId` is ever optional upstream. Reject or namespace the empty case explicitly.
- **[minor]**: `src/retry.ts` already exports `exponentialBackoff`; this PR reimplements the same formula inline in `fetchWithRetry`.

```json review-findings
{"schema":"review-findings/v1","verdict":"changes_requested","findings":[{"severity":"blocking","path":"src/cache.ts","line":88,"body":"buildCacheKey joins tenantId and resourceId with ':' but doesn't guard against tenantId === \"\", so a request with no tenant produces the same key as a request for tenant \"\" on the same resource. Reject or namespace the empty case explicitly."},{"severity":"minor","body":"src/retry.ts already exports exponentialBackoff; this PR reimplements the same formula inline in fetchWithRetry."}]}
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

## Who reads the block

Two readers share one parser and one author rule, both via
`classifyReviewIssueComment` in `src/pipeline/review-ledger.ts`: the in-run
`post-push-review` step, and the `issue_comment` webhook handler
(`src/webhook.ts`), which reads the block from a comment posted *after* the
run already ended — a reviewer that finishes late still starts a review-fix
run instead of being silently dropped. See
[docs/review-fix-rail.md](review-fix-rail.md) for the post-run half of the
rail and the full author-eligibility and dispatch-gating rules.

## Claude Code Review as the reviewer

A project whose review process is `claude-code-review` (ADR 038, `src/review-process.ts`) does not need to emit the block. The reader takes the strongest source present, in this order:

1. **A `review-findings` block** from a trusted comment: its verdict and findings win (`source: "review-contract"`). A block with no verdict reads as `incomplete`.
2. **The hosted service's check run**, `Claude Code Review` from app `claude`. Its conclusion is always `neutral` and is not read. The verdict comes from the line ending its Details, `<!-- bughunter-severity: {"normal":N,"nit":N,"pre_existing":N} -->`: `normal > 0` is `changes_requested`, else `approve` (`source: "bughunter-severity"`).
3. **The repository's own `claude-code-action` job**, a completed check from app `github-actions` (named `review` by default). `success` with no blocking inline comment on the head is `approve`; a blocking comment is `changes_requested`; any other conclusion is `no-real-verdict` (`source: "check-and-comments"`).
4. **No completed matching check** is `incomplete`.

Inline comments count only from a trusted author of type `Bot`, on the head commit (or with no commit id). A body starting 🔴 is `blocking`, 🟡 is `minor`, 🟣 (pre-existing) adds no finding, and an untagged comment is recorded as `minor`, so a reviewer that emits no markers never blocks a merge by itself. The `claude` check is matched by app slug and name together: a check named `Claude Code Review` from `github-actions` is not the hosted one.
