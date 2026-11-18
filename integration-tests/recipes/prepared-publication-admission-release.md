---
target: orchestrator
auth: admin
timeout_minutes: 5
---

# Prepared publication authority ends on admission release (AII-1754)

Manual: use an isolated test orchestrator with prepared-attempt fixtures; never mutate a production admission. This checks authorization, without a live Fly/local launch or an external write.

## Steps

1. For each canonical backend (github-actions, fly-machines, local-docker), prepare a launch_intent attempt with a future deadline and an unreleased matching admission. Bind matching positive run IDs for GHA or a non-null execution reference for machine backends. Obtain its result bearer through the trusted test fixture.
2. Send the result bearer to the pre-write publication authority handler with the matching repository and, for GHA, matching run IDs. Expect 200.
3. Release the admission while leaving the attempt in launch_intent. Repeat the pre-write check. Expect 403.
4. Verify the same bearer through ordinary result verification without publicationExecution. Expect success until credential expiry; explicit authority revocation must still reject it.
5. On fresh fixtures, confirm unbound execution, terminal attempt, explicit revocation and the exact publication deadline all reject the pre-write check.

## Asserts

- Release ends publication authority on all three backends even before attempt state changes.
- Result-delivery retry grace remains available without publicationExecution.
- No GitHub write, live Fly/local launch, or staged-writer boundary change is required.
