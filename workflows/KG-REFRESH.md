---
model: claude-sonnet-4-6
---

You are reviewing the output of an automated knowledge-graph ingest. The pipeline's `kg-ingest` step has already run the ingest as a deterministic process — `snapshot/`, `snapshot/parts/`, `snapshot/embeddings.npz`, `snapshot/embeddings.stamp`, and `ai-output/kg-stats.json` should all be present. Leave every change uncommitted.

## Context

- Issue: ${ISSUE_IDENTIFIER} — ${ISSUE_TITLE}
- KG source repo: the repository checked out in your workspace

## Steps

### 1. Reconcile `sources.yml` scope (mechanical diff only)

Compare the current `sources.yml` against the live set of repos and teams:

- Add entries for repos or teams that clearly exist but are absent.
- Remove entries for repos or teams that have clearly been deleted or renamed.
- **Never add, modify, or remove `docs_sites:` entries.** Docs-site scope is an operator decision. If you encounter a docs-site question (a new site that should be tracked, an old site that may be stale, a site whose URL changed), record it in the run report (`ai-output/comments/01-report.md`) under a **"Docs-site questions"** section and move on. Do not guess and do not write any `docs_sites:` change.

If `sources.yml` does not exist or the repo has no such file, skip this step and note it in the run report.

### 2. Verify the snapshot

Confirm that the ingest step's outputs are present:

- `snapshot/parts/` exists and contains at least one non-empty `.nt` file.
- `snapshot/embeddings.npz` exists and is non-empty.

If either check fails, write the details to the run report and stop — do not fabricate snapshot files.

### 3. Stamp file

`snapshot/embeddings.stamp` should have been written by the ingest step. It contains a UTC ISO-8601 timestamp of the form `YYYY-MM-DDTHH:MM:SS+00:00`. Do **not** overwrite or recreate this file.

If the stamp file is absent or has an unrecognised format, report it and stop.

### 4. Read the stats

`ai-output/kg-stats.json` was written by the `kg-ingest` pipeline step. Read it and use the values in the run report. The file contains:

```json
{
  "quads": <number of RDF quads>,
  "vectors": <number of embedding vectors>,
  "docPages": <number of documentation pages>,
  "durationSec": <ingest wall-clock seconds>
}
```

If the file is absent or unparseable, note it in the report.

### 5. Write the run report

Write `ai-output/comments/01-report.md` with:

- **Outcome**: success or the specific failure encountered.
- **Stats summary**: quads, vectors, doc pages, duration (human-readable, from `ai-output/kg-stats.json`).
- **Docs-site questions** (if any): list each question clearly so an operator can decide.
- **sources.yml changes** (if any): summarise what was added or removed.
- **Any warnings or anomalies** observed in the snapshot outputs.

### 6. Leave all changes uncommitted

Do **NOT** run `git add`, `git commit`, `git push`, or open a pull request. The pipeline step that follows this run owns the repository write. Modified files in `snapshot/` and new files in `ai-output/` will be picked up by the pipeline.

The reviewer is configured to treat uncommitted output under `snapshot/` and `ai-output/` as **expected**, never as a gap. Approval is decided solely by whether the four ingest checks pass (parts written, embeddings rebuilt, stamp written, stats written) — not by the working-tree state.
