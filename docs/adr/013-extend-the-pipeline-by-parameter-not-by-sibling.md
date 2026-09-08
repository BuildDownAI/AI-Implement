# 013. Extend the pipeline by parameter, not by sibling

**Status:** Accepted
**Date:** 2026-09-08

**References:** AII-555 (consolidation lane), AII-556, AII-557, AII-583; `docs/kg-architecture.md` §"Architecture — what is shared and what is kg-refresh-only"

---

## Context

When the kg-refresh run kind was introduced (AII-493, AII-494), several new files were created alongside existing ones rather than parameterizing the originals:

- `workflows/claude-kg-refresh.yml` alongside `workflows/claude-implement.yml`
- `src/repo-image.ts` `resolveKgRefreshSessionImage` alongside `resolveRunnerImageForDispatch`
- `session/git-credential-helper-kg-push.sh` + `src/kg-push-token-vending.ts` + `POST /api/runner/kg-push-token` alongside `push.ts` `refreshRunnerGithubCredentials`

Each sibling duplicated behavior the original already provided, diverged from it under maintenance, and created its own failure modes. The kg-push credential helper's independent `/api/runner/kg-push-token` endpoint failed with "Repository not found" on 2026-09-08 (run 34232181245) — a failure path the standard `refreshRunnerGithubCredentials` call never takes, because it never leaves the standard push flow.

The pattern repeats the same structural mistake: a run kind that needs a slight variation on an existing behavior copies the whole behavior rather than threading a parameter through the shared code path.

---

## Decision

**Prefer a parameter of an existing file over a new sibling.** When a new run kind (issueless or otherwise) needs a variant of pipeline behavior, extend the existing step/function/endpoint with an optional parameter rather than creating a new file that duplicates its logic.

A sibling is justified only when there is genuinely no shared counterpart — a state machine, a dedicated pipeline entrypoint, a tracker-data proxy scoped to one run kind's data contract. Rows in the `docs/kg-architecture.md` shared/kg-only table with no entry in the "Shared / existing path" column are the reference examples of legitimate siblings.

Data-path proxies that serve one run kind's internal contract (such as `/api/runner/kg-tracker-data`) are a narrow exception to this rule. They are legitimate siblings because no equivalent exists on the shared path — they carry run-kind-specific data (tracker state, not a push credential), and a shared step cannot consume them. A new proxy is justified only when it carries data that has no shared analogue; a proxy that vends a write credential for a path the pipeline already handles is not justified.

---

## Alternatives considered

- **Allow siblings freely** — the short-term path of least resistance, but it produces diverging behavior and distinct failure modes as the kg-refresh (and future issueless run kinds) accumulate their own copies of every shared concept. Rejected: the AII-555 consolidation lane exists to unwind exactly this outcome.
- **Merge all siblings into a single shared entry point** — overcorrects in the other direction; a kg-refresh state machine and pipeline entrypoint have no shared counterpart and genuinely belong as their own files. The rule is directional, not absolute.

---

## Consequences

- New issueless run kinds start from the shared step list (`docs/issueless-runs.md`) and extend steps by optional parameter rather than by new file.
- A code review that finds a new sibling with an existing shared counterpart is a blocking finding, not a style note.
- The runner-callback endpoint surface stays narrow: `kg-tracker-data` is the one surviving data-path proxy for kg-refresh. A second proxy requires the same justification (no shared analogue, run-kind-specific data contract).

---

## Violations

Violations found and collapsed during the AII-555 consolidation lane. Each row names the sibling that was removed and the shared path it was collapsed into.

| Sibling (removed) | Shared path reused | Collapse issue |
|---|---|---|
| `workflows/claude-kg-refresh.yml` | `workflows/claude-implement.yml` with `runner_phase: "kg-refresh"` | AII-556 |
| `resolveKgRefreshSessionImage` in `src/repo-image.ts` | `resolveRunnerImageForDispatch` in `src/repo-image.ts` | AII-557 |
| `session/git-credential-helper-kg-push.sh` + `src/kg-push-token-vending.ts` + `POST /api/runner/kg-push-token` | `refreshRunnerGithubCredentials` in `src/runner-token.ts`, called from `kg-snapshot-push.ts` | AII-583 |
