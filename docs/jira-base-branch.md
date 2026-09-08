# Jira base branch

An issue can name the branch its PR targets, instead of the target repo's default
branch. The value comes from a Jira custom field and rides to the runner in
`run_config.baseBranch` — the same envelope field feature-branch grouping already
uses, and the same one `push.ts` already honors when it opens the PR.

Jira-only. `TicketIssue.baseBranch` is populated by the Jira provider; the Linear
provider never sets it, exactly as with `profiles`.

## Configuring it

Create a **short text** custom field named exactly `AI-Implement Base Branch`, or
pin its id with `baseBranchFieldOverride` on the mapping's `ticketingConfig`
(Projects edit dialog, the add-project wizard's Jira step, or the mappings API).

Field discovery is by name and is best-effort: a missing or ambiguous field logs a
warning and leaves the feature inactive, rather than failing the poll. With all four
of `statusFieldOverride`, `repoFieldOverride`, `profilesFieldOverride` and
`baseBranchFieldOverride` set, `resolveCustomFieldIds` skips the `listFields` call
entirely.

## What happens to the value

| Stage | Behavior |
|---|---|
| Read (`readBaseBranchValue`) | Non-string shapes return undefined — the field may be created as Paragraph (ADF object) or a number field, and an unchecked `.trim()` would take down the whole snapshot for one bad value |
| Normalize (`normalizeBaseBranch`) | Trimmed; blank is unset; `refs/heads/` and `refs/remotes/` forms rejected; ref segments validated |
| Invalid value | Warned and left unset **for that issue only** — never fails the snapshot |
| Dispatch | Validated against GitHub, then carried in `run_config.baseBranch` |

`normalizeBaseBranch` shares `validateRefSegments` with `normalizeBranchPrefix`, so
the ref-safety rules (no `..`/`//`, each segment alphanumeric-initial, no trailing
`.`/`.lock`) cannot drift between the two.

## Refusals

Three cases are refused **before dispatch**. Each moves the issue to
Planning/Implementation Failed with a comment naming the reason, rather than
dispatching a run that would fail later:

1. The value is not a valid ref.
2. The branch does not exist on GitHub.
3. The issue is also part of a feature-branch grouping tree — the two ways of
   choosing a base are mutually exclusive. Clear one or the other.

Refusal 3 is checked **before** the grouping roll-up hold, so a misconfigured
grouping parent surfaces the conflict instead of being held indefinitely.

## Resolution order

Implementation dispatch takes the validated field value when set, and otherwise
falls through to `resolveBaseBranch` (feature-branch grouping → repo default).
Planning does not consult `featureBranchChain` at all — that grouping applies only
to implementation — so planning clones the field value or the repo default.

## The branch comment

When the field is set and differs from the repo default, the orchestrator comments
the branch on the ticket, so a plan/implement mismatch is visible.

The comment gates on the **field value**, never on the fully-resolved base. This
matters: the resolved base also covers the feature-branch-grouping fallback, and a
grouping run must not produce a comment claiming the user chose that branch. In
`both` (shadow) mode the Fly dispatch passes no `branchInfo`, so the comment is
posted exactly once.

## Scope

No effect on `/ai-implement` gap-fill or review-fix re-dispatches, which inherit
their PR's established base.

## Legacy-contract repos

On the envelope contract the branch rides inside `run_config` and needs no workflow
input. On the **legacy** contract it is sent as a `base_branch` `workflow_dispatch`
input, and is only sent when it differs from the repo default so that repos on the
common path cannot be rejected for an unexpected input.

A legacy dispatch that is rejected 422 *and* whose error body mentions `base_branch`
is attributed to a stale `claude-implement.yml` / `claude-plan.yml`, and the issue
is failed with that explanation. The check requires the error body to name the input
because a 422 has many possible causes and the "sent a base branch" condition is
also true for the pre-existing grouping path.

> Note: `base_branch` is not currently declared in the synced workflow templates, so
> on a legacy-contract repo this input is rejected. That predates this feature —
> feature-branch grouping already sends the same input — and is tracked separately.
