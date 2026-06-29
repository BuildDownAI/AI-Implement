# Per-Project Skills-Repository Integration — Design Decisions

**Parent issue:** [AII-141](https://linear.app/eudoxus/issue/AII-141/per-project-skills-repository-integration)
**Tracker:** Linear · team AI-Implement (AII) · project *Cloudshare Production-Readiness* · milestone *M1*
**Date:** 2026-06-29

## Objective

Let each project mapping name its own **skills git repo**. At dispatch the runner clones that repo and installs its skills into the coding CLI's discovery path (`~/.claude/skills/`) so Claude Code can use them. When no skills repo is set, nothing is installed (today's behavior). This unblocks the Cloudshare sign-off and downstream work (AII-149 Jira skills, AII-114 compound/review dogfood).

## Scope

**In v1:**
- New optional `skillsRepo` field on `RepoMapping` (schema + migration + admin API validation/persistence).
- Admin UI field in the **new-project stepper** and the **edit dialog**.
- Orchestrator forwards the skills repo to the runner: `workflow_dispatch` input (GitHub Actions mode) + runner env var (Fly/local mode) + the `claude-implement.yml` template input.
- Runner step: **clone** the skills repo (using the GitHub token already present) and **install** it — copy each top-level dir containing a `SKILL.md` into `~/.claude/skills/<name>/`.
- Comment-triggered (`/ai-implement`) gap-fill parity via a repo **variable** `AI_IMPLEMENT_SKILLS_REPO`.
- Implemented for **Claude Code** only.

**Deferred (tracking issues, no `AI-Implement` label):**
- Generalize the install step to other coding CLIs (Codex, Cursor, Aider, …).
- Option B: pin the skills repo to a specific branch/ref instead of always-latest.

**Out of scope:**
- The **knowledge repo / "vice-versa"** cross-repo-awareness feature → carved out to [AII-178](https://linear.app/eudoxus/issue/AII-178) (related, no dependency).
- Running the customer skills repo's own `install.sh` (we replicate its effect via a controlled convention copy; no arbitrary-script execution).

## Decisions

- **Data model:** One nullable column `skills_repo TEXT` on the `mappings` table; one optional `skillsRepo?: string | null` field on `RepoMapping` (`src/config.ts`). Additive migration via the existing `ensureMappingsColumns()` `ALTER TABLE … ADD COLUMN` pattern (mirrors `branch_prefix`). No tightening, no backfill — a missing value means "no skills repo."
- **API surface:** `admin.ts` mapping create/update accepts `skillsRepo`, trims it, treats empty/whitespace as `null`, and validates it parses as an `owner/repo` or git URL. Round-trips through `getMappings()` / `upsertMapping()`. Mirrors `branchPrefix` validation.
- **UI surface:** A single text input ("Skills Repository — optional") in both `src/admin-ui/stepper.ts` (new project) and `src/admin-ui/pages/projects.ts` edit dialog. Blank = none. No table column. Sent in the same admin-API body as `branchPrefix`.
- **Dispatch surface:** New `skillsReposDispatchFields()` (GHA input `skills_repo`) and `skillsReposRunnerEnv()` (`AI_IMPLEMENT_SKILLS_REPO`) helpers in `src/github.ts`, mirroring the branch-prefix helpers. Sent **only when set** (so target repos that haven't re-synced `claude-implement.yml` aren't rejected for "unexpected inputs"). New `skills_repo` input + container env in `workflows/claude-implement.yml`.
- **Install mechanism:** Convention copy — walk the cloned repo's top-level dirs, copy any containing `SKILL.md` into `~/.claude/skills/<name>/`. **Always `$HOME/.claude/`, never the target repo's `.claude/`** so installed skills never appear in the PR diff. Deterministic and unit-testable; no execution of the repo's `install.sh`.
- **Trust boundaries:** The skills repo URL is operator-controlled (admin UI / repo variable), not user-input from an issue body. Clone uses the existing per-dispatch installation token; the skills repo must have the GitHub App installed (customer's responsibility), same token story as the target-repo clone. Installing only into `$HOME` keeps skills out of the committed diff.
- **Failure modes:** Skills repo unset → install step is a no-op (default). Clone fails (missing/private/unreachable) → log a clear warning and continue the run **without** skills rather than aborting (skills are augmentation, not a hard requirement). Repo has no `SKILL.md` dirs → install nothing, log how many were found.
- **Rollout:** Pure addition; no flag needed. Each layer ships behind its dependency (backend → UI/dispatch → runner). Target repos must **re-sync `claude-implement.yml`** before a mapping sets a skills repo (same caveat as run-caps / branch-prefix). Rollback = revert PRs; an unset field is inert.
- **Testing:** Unit tests for (a) config round-trip of `skillsRepo`, (b) `skillsReposDispatchFields` / `skillsReposRunnerEnv` assembly, (c) admin API validation (valid/blank/whitespace), (d) the install step's placement from a fixture skills repo into a temp `HOME`. The "skill is discoverable by `claude` in the runner" check is an **acceptance criterion** of the runner issue, not a separate gated job. "Model actually invokes the skill when relevant" is a **manual dogfood** (BuildDownAI/skills + AII-114), explicitly **not** a CI gate.
- **Observability:** Runner logs `[skills] cloned <repo>@<sha>; installed N skill(s) into ~/.claude/skills` (or the no-op / failure variant), at the existing `summary` log level.

## Overlap & Reconciliation

- **AII-178** *Knowledge-repository integration* — **carved out** of AII-141. Action: filed, linked as **related (no dependency)**. ✅ done.
- **AII-107** *Pass orchestrator-minted token to session machines* — **Dependency (soft)**. The runner already holds a usable token, so clone works today; AII-107 hardens it. Action: reference, **do not block**.
- **AII-149** *Adapt BuildDown skills to Jira* — **Downstream**. Consumes this mechanism. Action: leave; it depends on this.
- **AII-114** *Compound Engineering Skills* — **Adjacent / dogfood test-consumer**. Action: reference as the manual test target; not a child.
- **AII-158** *Figma → Jira → prod* — **Downstream** (M3). Action: leave.

## Proposed decomposition (detailed in the Phase 3 plan)

| # | Task | Shape | Label | Blocked by |
|---|------|-------|-------|-----------|
| T1 | Backend: `skillsRepo` on `RepoMapping` (schema + migration + admin API) | wide-and-shallow | AI-Implement | — |
| T2 | Admin UI: skills-repo field (stepper + edit dialog) | wide-and-shallow | AI-Implement | T1 |
| T3 | Dispatch wiring: GHA input + Fly env + `claude-implement.yml` input | deep-and-targeted | AI-Implement | T1 |
| T4 | Runner: clone + install skills into `~/.claude/skills/` (core) | deep-and-targeted | AI-Implement | T3 |
| T5 | Comment-trigger parity: `AI_IMPLEMENT_SKILLS_REPO` repo variable | deep-and-targeted | AI-Implement | T4 |
| T6 | Tracking: generalize install to other coding agents | — | none (tracking) | related |
| T7 | Tracking: Option B — pin skills repo to a branch/ref | — | none (tracking) | related |

**Critical path:** T1 → T3 → T4 → T5. T2 runs parallel to T3 (no shared files: admin-ui vs github.ts/index.ts/workflows).

## Open Questions

None blocking. Proposed defaults if unspecified later:
- Install target dir name collisions (a skill name already in `~/.claude/skills/`) → last-writer-wins with a logged overwrite; revisit only if a real collision surfaces.
