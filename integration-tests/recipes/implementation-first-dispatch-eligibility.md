---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Implementation first-dispatch eligibility (AII-1555)

Manual: use an isolated test fixture with fake backend transports and disposable
issues; do not change live credentials or dispatch live runners.

## Steps

1. Submit first-time ImplementationRun inputs for Fly with a missing sessions token
   or app, and for Fly and local Docker with Bedrock or missing unmanaged model credentials.
2. Repeat with managed credentials and no environment model credential, API auth,
   OAuth auth, and GitHub Actions.
3. Seed an admission for a prior ambiguous Fly launch, then remove configuration
   or fail the backend read. Repeat with a recorded machine ID after configuration changes.

## Asserts

- Ineligible first-time runs finish refused before backend reads or creates, without
  admission, job, dedup, or tracker-running transitions.
- Eligible authentication modes and GitHub Actions retain their launch behavior.
- Recovery still adopts recorded IDs and searches for unrecorded Fly launches;
  missing configuration and failed reads throw rather than proving backend absence.
- Workflow input and journal command names remain unchanged; journal values contain no secrets.
