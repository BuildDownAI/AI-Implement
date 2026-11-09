---
target: orchestrator
auth: none
timeout_minutes: 5
---

# GET / reflects Restate availability (AII-1750)

Manual: observe an isolated test orchestrator during provisioning and after registration. The unavailable window may be brief because startup failures shut down the process.

## Steps

1. Start a test orchestrator with a fresh Restate data directory and valid orchestrator configuration.
2. While the sidecar starts or registration is pending, run `curl -i http://localhost:8080/`. Expect HTTP 503 and top-level `status: "unavailable"`; the body still includes `restate`, `sourceCommit`, poll fields, and setup-check diagnostics.
3. After the sidecar is ready and registration succeeds, repeat the request. Expect HTTP 200 and `status: "ok"`, with `restate.sidecar.state: "ready"` and `restate.registration.state: "registered"`.
4. Confirm the body keys match across both responses; only values change.

## Asserts

- HTTP 200 / `ok` occurs only for ready / registered.
- Every other observed Restate state returns HTTP 503 / `unavailable` while the process can still respond.
- Diagnostics remain readable in a 503 body; use curl without `-f`.
