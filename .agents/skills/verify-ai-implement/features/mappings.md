# Project mapping inventory

## Sub-features

Inspect the operator’s current tracker-to-repository mappings.

## How to get to it (user POV)

Authenticate and request GET /api/mappings.

## Driving it with verify.py

Run `.agents/skills/verify-ai-implement/verify.py mappings` from the root after building. The inventory returns 200 and exactly {} for a newly initialized database. Inspect http.jsonl in the printed evidence directory.

## Gotchas

A populated inventory requires project configuration. An empty inventory only proves the first-run view.
