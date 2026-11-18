---
target: orchestrator
auth: admin
timeout_minutes: 5
---

# Re-import repairs an unreadable environment credential (AII-1832)

Manual: use an isolated test orchestrator with an environment model credential and a disposable database. Do not print the credential or its stored reference.

## Steps

1. Call `import_environment_credential` as an admin with empty arguments. Expect status 201 and `result: "created"`.
2. Call again with a fresh invocation. Expect status 200 and `result: "already-imported"`.
3. Rotate `RUNNER_TOKEN_SECRET` and restart the test orchestrator, retaining its database and environment model credential. Confirm Models & providers shows the adopted credential as unreadable.
4. Call the tool with a fresh invocation. Expect status 201 and `result: "created"`; confirm Models & providers reports the credential is set and readable.
5. Repeat with a fresh invocation. Expect status 200 and `result: "already-imported"`.
6. Inspect the decoded import invocation journals and responses. Neither the credential value nor its stored reference may appear.

## Asserts

- Re-import reseals an unreadable credential without creating a profile revision or changing stage defaults.
- A readable credential is left unchanged.
- Import responses and journals contain only the existing non-secret metadata.
