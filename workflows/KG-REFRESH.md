---
model: claude-sonnet-4-6
---

You are running a knowledge-graph ingest refresh. Your workspace is a clone of the KG source repository. The pipeline owns all repository writes — leave every change uncommitted.

## Context

- Issue: ${ISSUE_IDENTIFIER} — ${ISSUE_TITLE}
- KG source repo: the repository checked out in your workspace

## Steps

### 1. Set up the Python venv

Prefer `python3.10`. If `python3.10` is unavailable fall back to the next available version, but record it in the run report.

```bash
python3.10 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt   # or equivalent for this repo's tooling
```

If the repo uses a different dependency file (e.g. `pyproject.toml`, `setup.py`, `Pipfile`), adapt accordingly.

### 2. Reconcile `sources.yml` scope (mechanical diff only)

Compare the current `sources.yml` against the live set of repos and teams:

- Add entries for repos or teams that clearly exist but are absent.
- Remove entries for repos or teams that have clearly been deleted or renamed.
- **Never add, modify, or remove `docs_sites:` entries.** Docs-site scope is an operator decision. If you encounter a docs-site question (a new site that should be tracked, an old site that may be stale, a site whose URL changed), record it in the run report (`ai-output/comments/01-report.md`) under a **"Docs-site questions"** section and move on. Do not guess and do not write any `docs_sites:` change.

If `sources.yml` does not exist or the repo has no such file, skip this step and note it in the run report.

### 3. Run the ingest

Execute the ingest as the repo documents it (check `README.md`, `Makefile`, or a `scripts/` directory). Typical invocation:

```bash
python scripts/ingest.py        # or
make ingest                     # or
python -m kg_ingest             # adapt to this repo
```

Follow any additional instructions in a `WORKFLOW.md` in the workspace if one exists.

If the ingest fails, diagnose the failure and retry with reasonable fixes (dependency issues, stale cache, transient network error). If it cannot be recovered in this run, write the failure details to the run report and stop — do not fabricate snapshot files.

### 4. Verify the snapshot

After the ingest completes, confirm:

- `snapshot/parts/` exists and contains at least one non-empty `.nt` file.
- `snapshot/embeddings.npz` exists and is non-empty.

If either check fails, write the details to the run report and stop without writing a stamp file.

### 5. Write the stamp file

Write the current UTC time as an ISO-8601 string to `snapshot/embeddings.stamp`:

```bash
python3 -c "import datetime; print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))" > snapshot/embeddings.stamp
```

### 6. Write the stats file

Write `ai-output/kg-stats.json` with counts from the ingest:

```json
{
  "quads": <number of RDF quads ingested>,
  "vectors": <number of embedding vectors in embeddings.npz>,
  "docPages": <number of documentation pages processed (0 if none)>,
  "durationSec": <total ingest wall-clock seconds as a number>
}
```

All four fields are required. Use 0 for docPages when the ingest does not process documentation.

### 7. Write the run report

Write `ai-output/comments/01-report.md` with:

- **Outcome**: success or the specific failure encountered.
- **Stats summary**: quads, vectors, doc pages, duration (human-readable).
- **Docs-site questions** (if any): list each question clearly so an operator can decide.
- **sources.yml changes** (if any): summarise what was added or removed.
- **Python version used**.
- **Any warnings or anomalies** from the ingest.

### 8. Leave all changes uncommitted

Do **NOT** run `git add`, `git commit`, `git push`, or open a pull request. The pipeline step that follows this run owns the repository write. Modified files in `snapshot/` and new files in `ai-output/` will be picked up by the pipeline.
