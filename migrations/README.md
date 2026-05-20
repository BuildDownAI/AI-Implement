# Migrations

One-time-migration utilities for teams adopting AI-Implement.

These scripts are not part of the orchestrator's runtime path. They run on the client side, typically once per team, to migrate from a prior issue-tracking setup to Linear (the tracker AI-Implement currently assumes).

## Available migrations

### `migrate_github_project_to_linear.py`

Migrate a GitHub Projects v2 project to a Linear project. Four idempotent phases:

| Phase | Action |
|---|---|
| `preflight` | Read-only audit; prints summary, validates structure, no writes |
| `structure` | Create Linear project + labels (skips if exist) |
| `migrate` | Create Linear issues + comments + post GH cross-link comments back to source |
| `verify` | Count + spot-check migrated issues against the GH source |

**Field mappings** (all overridable via CLI):

- **Status:** GH closed → Linear `Done`; GH open → Linear `Todo` (not `In Progress` — work hasn't started in Linear yet)
- **Priority:** P0 → Urgent (1), P1 → High (2), P2 → Medium (3), P3 → Low (4), no P-label → No priority (0)
- **Type labels** (bug/improvement/documentation/config) → Linear labels (preserved)
- **Priority labels** (P0–P3) → Linear's priority field, NOT labels
- **Status labels** (in-progress) → Linear's state, NOT labels

**Requirements:**

- `LINEAR_API_KEY` environment variable
- `gh` CLI authenticated against the source repo
- Python 3.10+

**Example invocation** (the migration this script generalizes):

```bash
export LINEAR_API_KEY=lin_api_xxx

python migrate_github_project_to_linear.py preflight \
    --gh-owner jodwyer --gh-repo alpacaWheel --gh-project 7 \
    --linear-team Oolidata --linear-project "Position Lifecycle Management"

# Review the preflight report, then:
python migrate_github_project_to_linear.py structure --config <same args>
python migrate_github_project_to_linear.py migrate   --config <same args>
python migrate_github_project_to_linear.py verify    --config <same args>
```

**Idempotency:** each phase writes a log file (`.migration-state.json`) recording what was created. Re-running a phase skips already-migrated rows. Safe to re-run if interrupted.

**Provenance:** generalized from a production migration in `jodwyer/alpacaWheel` (GitHub Project 7 → Linear `Position Lifecycle Management` project), May 2026. 81 issues migrated successfully. The script handles done-tombstones, label preservation, GH ↔ Linear cross-link comments, and idempotent re-runs.

**After migration:** consider running the [`project-triage` skill from BuildDownAI/skills](https://github.com/BuildDownAI/skills) — migrations frequently leave parent issues open even when their substantive work shipped via PRs (done-tombstones). Project-triage classifies and closes them.

## Adding a new migration here

Migrations belong in this directory when they:

- Run **once** per team adopting AI-Implement (not on every dispatch)
- Migrate from a **prior tracker setup** (GH Projects, Jira, etc.) to Linear
- Are **idempotent** (re-runnable without corruption)
- Carry their own configuration via CLI flags (no hardcoded team / repo / project values in code)

Operational scripts (provisioning, secret-setting) belong in `scripts/`, not here.
