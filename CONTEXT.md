# Glossary

Domain terms with one meaning each. Implementation detail stays out; that belongs in `docs/` and the ADRs.

## Recipe

A file in the target repository that describes one integration test in a form an agent can execute against a deployed environment. A recipe states the target, the steps, and the pass/fail assertions.

**Not to be confused with:** an in-repo test-suite test (vitest), which runs against code, not against a deployed environment.

## Test target

The deployed environment a recipe runs against. The first test target is the AII testing orchestrator. A preview environment and an external system (for example Topia) are also test targets.

**Not to be confused with:** the target repository, which is the codebase a pipeline run implements issues in.

## Preview environment

A deployment of one PR branch, reachable before merge, used as a test target and torn down after use. In AI-Implement a preview environment is one Fly machine in the standing previews app (ADR 012).

**Not to be confused with:** the testing orchestrator, which is the standing post-merge environment.
