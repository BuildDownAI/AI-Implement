# Bug-fix tests: reproduce first, then fix

The pattern for fixing a bug in this repo. The test that proves the bug is written before the fix, and the pull request shows it failing.

## The steps

1. **Find the seam.** Name the function that holds the wrong behaviour and the fake that already drives it. Most orchestrator modules take an injected `fetch` or client (`fetchImpl`, `getInstallationTokenImpl`); reuse the fake in the module's existing test file before writing a new one.
2. **Write the failing test.** Assert the correct behaviour, not the bug. Run it on the unfixed code and keep the output.
3. **Record the red output.** Commit the test first, or paste the failing `npx vitest run <file>` output into the PR body under "Before the fix".
4. **Fix the code** with the smallest change that turns the test green. No drive-by refactors.
5. **Run the whole suite.** `npm test` and `npm run typecheck`. Existing tests must pass unchanged unless the bug was in what they asserted — say so in the PR.
6. **Add a recipe when the bug is visible from outside.** If an operator can see the bug on a deployed orchestrator, add an `integration-tests/recipes/` file (AII-472 format) so the check can run again later.

Tests and fix ship in **one** pull request. A pull request that contains only failing tests fails CI and never gets the runner's approval mark.

## Which tier

Use a unit test (`src/__tests__/<module>.test.ts`) unless the assertion is about the Restate engine itself. The rule is in `docs/restate-testing.md` § "When to write a Restate test, and when a unit test". Remember that `npm run typecheck` does not check `src/__tests__`; type-check a new test file with a throwaway tsconfig.

## Worked example: AII-738

The workflow sync wrote `claude-implement.yml` even when a mapping named `claude-implement-2.yml`.

- Seam: `syncWorkflowTemplates` in `src/workflow-sync.ts`; fake: `makeGithubFetch` in `src/__tests__/workflow-sync.test.ts`.
- Failing tests (PR [#620](https://github.com/BuildDownAI/AI-Implement/pull/620), AII-739): the `describe("custom workflow file names (AII-739)")` block adds `"syncs the mapping's custom-named files with the standard template content"`, `"leaves the default-named files byte-for-byte unchanged when custom names are configured"`, and `"lists the custom-named paths in the PR body"`.
- Fix: `alwaysSyncFiles` in `src/workflow-sync.ts` builds each remote path from `mapping.workflowFile` / `mapping.planningWorkflowFile` instead of the hardcoded default names.
- Recipe: `integration-tests/recipes/workflow-sync-custom-names.md`.

## Second example: AII-740

A mapping save accepted a `workflowFile` with a path separator or the wrong extension, so a value like `../x.yml` or `dir/x.yml` could target a file outside `.github/workflows/`.

- Seam: the mapping-save handler in `src/admin.ts`; fixture: the `request`/`login` helpers already in `src/__tests__/admin.test.ts`.
- Failing tests (PR [#622](https://github.com/BuildDownAI/AI-Implement/pull/622), AII-740): `admin.test.ts`'s `it.each(["../x.yml"], ["dir/x.yml"], ["x.txt"])("rejects workflowFile %s and stores nothing", …)`, its `planningWorkflowFile` counterpart, and `"rejects workflowFile equal to planningWorkflowFile and stores nothing"`; `workflow-sync.test.ts`'s `"accepts bare .yml and .yaml names"` and `"rejects names with path separators, traversal, or the wrong extension"` cover the shared `isBareWorkflowFileName` helper directly.
- Fix: `isBareWorkflowFileName` and `workflowFileNamesCollide`, added to `src/workflow-sync.ts` and called from the mapping-save validation in `src/admin.ts`, reject the value with a 400 (`workflowFile must be a bare file name ending in .yml or .yaml`) before anything is stored.
