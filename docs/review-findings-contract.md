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

## Which Claude comments the pipeline reads

For `ai-implement`, a completed review check triggers a separate findings read.
The ledger first restricts eligible top-level comments to those created during the
review check on the resolved PR head. It then selects the newest by `updated_at`
(falling back to `created_at`, then API order for ties). It reads a fenced contract
first, then legacy review headings. Both a combined tracking/review comment and a
separate `## Claude review` comment are eligible; `**Claude finished**` is not
required. Progress-only comments without a review heading or contract are ignored.

Author eligibility is unchanged: contracts require the GitHub Actions identity
(`github-actions` or `github-actions[bot]`, with API type `Bot`) or a Claude author
trusted by the configured review process and extra-author allowlist. Heading-only
reviews use those same identities. Pipeline comments whose trimmed body starts
with `<!-- ai-implement` are excluded. A quoted marker elsewhere in review prose
does not identify the comment as pipeline-authored.

The selected trusted review supersedes older comments even when its contract is
malformed or its review content cannot be parsed. Such a review reports findings
as unavailable and prevents approval from a successful check alone. Blocking
contract findings gate even with only a path and no line. Recognized blocking
heading-only findings also gate approval under `ai-implement`, without requiring
`claude-review-summary` in the reviewer selection; minor findings remain
advisory. The step logs the selected comment id and parse kind beside its review
process verdict log. Top-level comments do not supply commit identity. The step uses the single matching
check with a real review conclusion, fetched from the current head's check-runs
endpoint, and its inclusive `started_at`–`completed_at` window. Comment creation
must fall inside that window; editing an older head's approval cannot bring it
into the current review. Missing/invalid check timing, multiple real review checks,
missing comment creation time, no eligible comment in the window, or an eligible
comment edited after completion makes the verdict unavailable. This intentionally
fails closed for sticky comments created before the current review; inline threads
retain their separate head-commit filtering.

## When the in-run step reads the outside verdict

The `post-push-review` step starts its outside-review wait after the internal
review returns. It polls the PR head's matching review checks every five seconds,
for up to **ten minutes** (600,000 ms of requested sleeps). Time already spent
on the outside review while the internal review ran is additional time in its
favor; GitHub API latency does not consume the sleep budget. The limit is a
constant, with no operator setting.

The operator-supplied measurements below come from AII PR comments created
3–10 November 2026 containing “Claude finished @ai-implement-orchestrator-bot[bot]'s
task in Nm Ss” lines, measured on 2026-11-10. The check-job sample is retained
separately because it is incomplete.

| Sample | Runs | Median | p90 | p95 | Maximum | Over 5 min | Over 10 min |
|---|---:|---|---|---|---|---:|---:|
| Claude completion comments (operator-supplied) | 181 | 3 m 44 s | 6 m 14 s | 7 m 25 s | 12 m 50 s | 47 | 2 |
| Check jobs retrieved before GitHub's unauthenticated rate limit (incomplete sample) | 112 | — | 6 m 53 s | — | — | — | — |

The chosen limit is **600,000 ms**, giving the completion-comment p90 a
**3 m 46 s** margin (and the observed check-job p90 a 3 m 7 s margin).
The incomplete check sample does not establish the full window's check p90.
Compared with the previous five-minute limit, this adds **at most 5 more minutes
per wait, and only when the outside review is still running**; reviews that
finish sooner return as soon as a poll sees completion.

For `ai-implement`, a completed check also probes the trusted current-review
comment. A standalone “Claude is working…” tracker keeps the wait pending; a
combined tracker and readable final review counts as final. Missing comments
and failed comment reads, incomplete verdicts, and temporarily unparseable reviews
retry within the same budget. Comments must be created since the current head’s
check started; final publication or tracker edits may follow check completion.
Editing a comment created before that check cannot make it current. A newer trusted tracker
supersedes an older verdict; foreign authors cannot supply either state.

The wait preserves these outcomes:

| State | Meaning and gate behavior |
|---|---|
| `completed` | A matching check finished with a real verdict and its current-review comment is final. Read its findings and apply the normal approval gates. Completion alone does not grant approval. |
| `running` | A review is still pending, or its check/head could not be read before the budget expired. Fail closed with `external_review_pending` and no approval. |
| `absent` | No matching external check exists. Require two consecutive probes before failing open. With no internal reviewer, an absent external check still fails closed because no review was obtained. Once a matching check has been seen, a later empty result is treated as unreadable and cannot fail open. A successfully read PR with no head SHA retains its immediate `absent` behavior. |
| `no-real-verdict` | Matching checks finished without a usable verdict. Require two consecutive probes, then fail closed. |
| `permission-denied` | The App cannot read checks. Stop immediately and fail closed with `CHECKS_PERMISSION_DENIED`. |

An intervening running or unreadable probe resets the consecutive-probe
settling rule for `absent` and `no-real-verdict`. A transient head-read failure
is retried within the same budget. Non-default review processes keep their
existing verdict readers: an incomplete contract keeps waiting, while a
completed check without a readable real verdict fails closed. Reaching the
limit does not turn a pending check into a completed review or approval.

After the wait, the step calls `collectExternalReviewFindingsFromGh` once per
review iteration (unless external collection was skipped). It reuses the issue
comments fetched by the last probe when available; otherwise the collector
fetches them. The collector also reads formal reviews and unresolved review
threads. For `ai-implement`, a completed check requires a current-review comment
under [the comment rules above](#which-claude-comments-the-pipeline-reads). For
a review process other than `ai-implement`, the step passes the wait's head SHA
to scope the findings read to that head. The wait follows both check completion and comment finality, and passes the
last probe’s issue comments to the findings collector without another verdict
fetch. The findings read must still produce a usable verdict before approval. A check
without a real verdict cannot approve on the strength of older findings.

If a recognized external review comment cannot be parsed into usable findings
or an explicit clean verdict, the collector sets `findingsUnavailable`. This
blocks approval even when the internal reviewers found no problems. In that
case, the step reports “AI-Implement cannot read the verdict of the external
review” and requires manual review, with no approval.

The post-run late-review rail can still consume a verdict that arrives after
the in-run wait ends; see [review-fix-rail.md](review-fix-rail.md).
