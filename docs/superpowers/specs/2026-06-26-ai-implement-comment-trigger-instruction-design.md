# `/ai-implement` comment trigger: prefix-match + pass instruction to the run

**Linear:** AII-172
**Date:** 2026-06-26
**Status:** Design approved, ready for implementation plan

## Problem / Context

The `/ai-implement` PR comment trigger only fires when the comment body is **exactly**
`/ai-implement`. In `workflows/comment-trigger.yml` (and its byte-identical mirror
`.github/workflows/comment-trigger.yml`), the *Check trigger command* step does:

```js
const body = context.payload.comment.body ?? "";
const matched = body.trim() === "/ai-implement";
```

So a comment that starts with `/ai-implement` but carries any trailing text is silently
ignored (`core.info("Ignoring comment because it is not exactly /ai-implement")`), and the
`implement` job is skipped (it is gated on `needs.check-trigger.outputs.matched == 'true'`).

### Real-world evidence

On `eudoxus-ai/thrivable-survey-dashboard` PR #129, the maintainer commented (2026-06-26 12:53:32Z):

> `/ai-implement follow-up — the failing test exposes a real correctness bug in the DISC-1 control, not a flaky test. Please fix the implementation (do NOT just weaken the test to make it pass …`

`comment-trigger.yml` **is** installed in that repo and **did** receive the `issue_comment`
event, but the exact-equality check evaluated `false`, so nothing ran — no reaction, no
gap-fill. This is the failure AII-172 targets, and it is also a perfect example of the
second half of the goal: the trailing text ("fix the implementation, don't weaken the
test") is exactly the instruction the operator wants the run to honor.

### Architecture clarification

- `comment-trigger.yml` is a **self-contained GitHub Actions workflow** synced to target
  repos. It fires on `issue_comment: [created]` events *in the target repo* and runs the
  runner container directly (`/opt/ai-implement/entrypoint.sh`). It does **not** depend on
  the orchestrator poller. The earlier "the poller isn't picking it up" theory was wrong:
  the workflow received the event and deliberately rejected it on the exact-match.
- The orchestrator-side `/trigger/gap-fill` endpoint (`src/gap-fill-trigger.ts`) is a
  separate path that is **not** reached from the current `comment-trigger.yml` (its own code
  notes comment-trigger.yml stopped POSTing to it). Out of scope here.
- `@claude` is a different mechanism (the target repo's own `claude.yml` interactive agent),
  not `/ai-implement`. Out of scope.

### Verified non-issue

A fast-recon pass flagged a possible "second critical bug": that gap-fill silently no-ops
when the feedback-loop review returns `approved !== true` (push step is gated on approval at
`pipeline-loader.ts:153`). This was verified to be a **misread**. In gap-fill mode the
prompt itself (`run-autonomous.ts:73`) instructs Claude to *"Commit your changes to the
current branch and push"* — gap-fill commits happen inside the **implement** sub-step, not
the approval-gated pipeline `push` step (which computes a fresh issue branch via
`buildIssueBranchName` and is correctly skipped for gap-fill). The confirmed cause of "not
picking up" is the matcher, nothing else.

## Goal

1. The trigger fires whenever a comment **starts with** `/ai-implement` at a word boundary.
2. Everything after the trigger token is passed through to the gap-fill run as an
   **authoritative operator instruction** that shapes the prompt.

## Non-goals / out of scope

- The orchestrator `/trigger/gap-fill` endpoint and the `@claude` interactive path.
- The unused `gap_analysis_model` WORKFLOW.md front-matter field (parsed in `workflow-md.ts`
  but never consumed in `run-autonomous.ts`). Real but tangential — file a separate ticket.
- Any change to **who** may trigger. The write/maintain/admin auth gate stays exactly as-is.

## Design

Two layers: the GHA matcher (so the trigger fires and carries the text), and the runner (so
the text shapes the prompt).

### Layer 1 — Workflow matcher

Edit **both** `workflows/comment-trigger.yml` **and** `.github/workflows/comment-trigger.yml`,
keeping them byte-for-byte identical (enforced by `workflow-shim-structure.test.ts`).

**1. "Check trigger command" step (current lines 51–61).** Replace the exact-equality match
with an anchored prefix match that also captures and base64-encodes the remainder:

```js
const body = (context.payload.comment.body ?? "").trim();
const m = body.match(/^\/ai-implement(?:\s+([\s\S]*))?$/);
const matched = m !== null;
core.setOutput("matched", matched ? "true" : "false");
if (!matched) {
  core.info("Ignoring comment: does not start with /ai-implement");
  core.setOutput("comment_instruction", "");
} else {
  const instruction = (m[1] ?? "").trim();
  // base64 so an arbitrary / multi-line instruction survives the job output,
  // mirroring the issue_description_b64 technique used elsewhere in this workflow.
  core.setOutput("comment_instruction", Buffer.from(instruction, "utf-8").toString("base64"));
}
```

Match behavior (acceptance cases):

| Comment (trimmed)                       | matched | instruction        |
|-----------------------------------------|---------|--------------------|
| `/ai-implement`                         | yes     | `""`               |
| `/ai-implement follow-up — fix X`       | yes     | `follow-up — fix X`|
| `/ai-implement\nfix X` (multi-line)     | yes     | `fix X`            |
| `/ai-implementfoo`                      | no      | (n/a)              |
| `I think /ai-implement is broken`       | no      | (n/a)              |

**2. `check-trigger` job `outputs:` (current lines 39–49).** Add:

```yaml
comment_instruction: ${{ steps.trigger.outputs.comment_instruction }}
```

**3. `implement` job "Run pipeline (gap-fill)" step `env:` (current lines 242–253).** Add:

```yaml
COMMENT_INSTRUCTION_B64: ${{ needs.check-trigger.outputs.comment_instruction }}
```

**4. `implement` job `run:` block (after the existing ISSUE_DESCRIPTION decode at line 259).**
Add, mirroring the existing decode style:

```bash
export AI_IMPLEMENT_COMMENT_INSTRUCTION=$(echo "$COMMENT_INSTRUCTION_B64" | base64 -d)
```

An empty `COMMENT_INSTRUCTION_B64` decodes to an empty string (exit 0), so bare
`/ai-implement` exports an empty `AI_IMPLEMENT_COMMENT_INSTRUCTION`.

**Auth & trust:** unchanged. The auth-check step still fails the `check-trigger` job for
non-write/maintain/admin actors, which skips `implement`. `comment_instruction` travels on a
**separate job-output channel** — it is *not* added to the `jq IN()` allowlist used to
eval `ISSUE_META`, so the meta-eval trust boundary is untouched. Injecting an operator's
free-form text is at the same trust level as someone who can already push to the repo.

**Bonus:** the existing "Acknowledge trigger" 👍-reaction step is gated on
`matched == 'true'`, so it now also fires for `/ai-implement <instruction>` — immediate
visible confirmation that the trigger fired.

### Layer 2 — Runner (`src/run-autonomous.ts`)

Read the new env var and thread it in as an **authoritative** block.

**Read** (near the other env reads, ~line 122):

```ts
const commentInstruction = optionalEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION");
```

`optionalEnv` trims and returns `null` for empty/absent — so bare `/ai-implement` and
non-comment runs leave behavior byte-for-byte unchanged.

**New helper** alongside `appendPipelineOwnedGitInstructions`:

```ts
function appendOperatorInstruction(prompt: string, instruction: string | null): string {
  if (!instruction) return prompt;
  return `${prompt.trimEnd()}

## Operator instruction for this run (authoritative)

The operator triggered this run with the instruction below. Treat it as the authoritative
directive for this run: if it conflicts with the default gap-fill behavior above, follow
this instruction.

${instruction}`;
}
```

**Wire it** immediately after the existing git-instructions append (current line 172), so it
applies whether the prompt body is the default gap-fill template or a custom `WORKFLOW.md`
body:

```ts
implementationPrompt = appendPipelineOwnedGitInstructions(implementationPrompt, prNumber);
implementationPrompt = appendOperatorInstruction(implementationPrompt, commentInstruction);
```

Gating is on **instruction presence only**, not `prNumber` — the env var is only ever set on
the comment-triggered gap-fill path, so in practice the block appears only on gap-fill runs,
but the logic stays simple and explicit.

## Tests

- **`src/__tests__/run-autonomous.test.ts`** (extends the existing gap-fill prompt test
  ~234–256, using `vi.stubEnv` + the single-step capture harness):
  - instruction set (`AI_IMPLEMENT_COMMENT_INSTRUCTION` + `PR_NUMBER`) → captured
    `implementationPrompt` contains `Operator instruction for this run` and the instruction text.
  - instruction absent → prompt does **not** contain `Operator instruction` (unchanged).
  - (optional) instruction set with a `WORKFLOW.md` body override → operator block still appended.
- **`src/__tests__/workflow-shim-structure.test.ts`:** update the assertion that currently
  pins `body.trim() === '/ai-implement'` (~line 206) to the new prefix matcher. The
  byte-for-byte dual-copy assertion (lines 88–92) continues to guarantee the two files stay
  identical.
- `npm run typecheck` and `npm test` pass.

## Docs

- **CLAUDE.md** (comment-trigger / gap-fill section): note that `/ai-implement <instruction>`
  now fires on prefix and passes the trailing text to the run as an authoritative operator
  directive; bare `/ai-implement` is unchanged.

## Operational notes (for the PR description)

This changes a synced workflow template **and** the runner image, so for the behavior to take
effect a target repo must:

1. **Re-sync `comment-trigger.yml`** (Projects → Sync workflows, or the manual fallback).
2. Run on a **rebuilt/published runner image** that includes the updated `run-autonomous.ts`
   (testing orchestrators pair with `:next`; production with `:latest`).

Until both are in place, `/ai-implement <instruction>` will either still be rejected (old
workflow) or fire but ignore the instruction (old runner).

## Acceptance criteria

- [ ] Bare `/ai-implement` still triggers a gap-fill run (no regression).
- [ ] `/ai-implement <text>` triggers a run and `<text>` (trimmed) reaches the runner.
- [ ] Multi-line instructions after the trigger are captured intact (base64 round-trip).
- [ ] `/ai-implementfoo` and comments that don't START with the trigger do NOT fire.
- [ ] A non-empty instruction is threaded into the gap-fill prompt as a distinct, authoritative
      operator-instruction block; an empty/absent instruction leaves the prompt unchanged.
- [ ] `workflows/comment-trigger.yml` and `.github/workflows/comment-trigger.yml` remain
      byte-for-byte identical.
- [ ] The write/maintain/admin auth gate on the commenter is unchanged.
- [ ] `npm run typecheck` and `npm test` pass.
