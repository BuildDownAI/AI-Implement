---
target: orchestrator
auth: none
timeout_minutes: 10
---

# OpenRouter GitHub Actions bootstrap (AII-1924)

Automated contract check; no live provider credentials or model calls required.

## Steps

1. Use Node 24 with dependencies installed and jq available.
2. Run `npx vitest run src/__tests__/workflow-token-masking.test.ts`.
3. Inspect the OpenRouter selection, fallback binding, and invalid auth-mode cases for both workflow templates and their .github/workflows copies.

## Asserts

- Claude and Codex OpenRouter primary selections reach the stub runner with the original snapshot and grant intact.
- An OpenRouter fallback binding with a distinct profile ID works alongside an OpenAI primary.
- Invalid OpenRouter auth combinations and unknown fallback binding modes fail before the runner with the fixed bootstrap error and no credential outputs.
- Successful bootstraps register masks and leave GITHUB_ENV empty.
