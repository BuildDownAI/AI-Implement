# `/ai-implement` comment trigger: prefix-match + pass instruction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/ai-implement` PR-comment trigger fire when a comment *starts with* `/ai-implement`, and pass any trailing text to the gap-fill run as an authoritative operator instruction.

**Architecture:** Two layers. (1) The GHA matcher in `comment-trigger.yml` (×2 byte-identical copies) is changed from exact-equality to an anchored prefix regex that captures the remainder, base64-encodes it, and plumbs it through a new `comment_instruction` job output → `COMMENT_INSTRUCTION_B64` env → `AI_IMPLEMENT_COMMENT_INSTRUCTION` (decoded). (2) The runner (`src/run-autonomous.ts`) reads that env var and appends an authoritative "Operator instruction for this run" block to the gap-fill prompt.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, GitHub Actions `actions/github-script` (Node), bash.

**Linear:** AII-172 · **Spec:** `docs/superpowers/specs/2026-06-26-ai-implement-comment-trigger-instruction-design.md`

## Global Constraints

- `workflows/comment-trigger.yml` and `.github/workflows/comment-trigger.yml` MUST remain **byte-for-byte identical** (enforced by `src/__tests__/workflow-shim-structure.test.ts` "keeps the canonical and synced comment trigger workflows byte-for-byte identical"). Always edit `workflows/comment-trigger.yml`, then `cp` it over the `.github/workflows/` copy.
- Do **NOT** add `comment_instruction` to the `jq ... IN("issue_id", "issue_identifier", "issue_title", "issue_description_b64")` allowlist. The instruction travels on a **separate job-output channel**; the ISSUE_META eval trust boundary stays unchanged (guarded by the "documents and constrains the ISSUE_META eval trust boundary" test).
- The commenter auth gate `["write", "maintain", "admin"]` is unchanged — do not broaden who can trigger.
- When absent/empty, the operator instruction must leave the runner prompt **byte-for-byte unchanged**.
- TypeScript imports use ESM `.js` specifiers (e.g. `from "../run-autonomous.js"`).
- Tests: `npm test` (vitest run), `npm run typecheck` (`tsc --noEmit`). Both must pass.
- Commits: conventional-commit style; end each message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- `src/run-autonomous.ts` — **modify.** Add `appendOperatorInstruction()` helper; read `AI_IMPLEMENT_COMMENT_INSTRUCTION`; wire the append after the existing git-instructions append.
- `src/__tests__/run-autonomous.test.ts` — **modify.** Stub the new env var in `beforeEach`; add the "instruction present" test; extend the existing gap-fill test with an "absent → unchanged" assertion.
- `workflows/comment-trigger.yml` — **modify.** Prefix matcher + remainder capture; new job output; new env var; decode line.
- `.github/workflows/comment-trigger.yml` — **modify (via `cp`).** Byte-identical mirror.
- `src/__tests__/workflow-shim-structure.test.ts` — **modify.** Replace the exact-match assertion with the prefix-matcher + plumbing assertions.
- `CLAUDE.md` — **modify.** Document `/ai-implement <instruction>` in the comment-trigger/gap-fill section.

---

## Task 1: Runner threads the operator instruction into the gap-fill prompt

**Files:**
- Modify: `src/run-autonomous.ts` (helper near `appendPipelineOwnedGitInstructions` ~line 93–103; env read ~line 122; wire ~line 172)
- Test: `src/__tests__/run-autonomous.test.ts` (`beforeEach` ~line 55–67; gap-fill test ~line 234–256)

**Interfaces:**
- Produces: `function appendOperatorInstruction(prompt: string, instruction: string | null): string` — returns `prompt` unchanged when `instruction` is falsy; otherwise appends a `## Operator instruction for this run (authoritative)` block containing the instruction. Reads env var `AI_IMPLEMENT_COMMENT_INSTRUCTION` (consumed by Task 2's workflow output).

- [ ] **Step 1: Stub the new env var in the test setup**

In `src/__tests__/run-autonomous.test.ts`, inside `beforeEach` (after the existing `vi.stubEnv("PR_NUMBER", "");` line), add:

```ts
    vi.stubEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION", "");
```

- [ ] **Step 2: Extend the existing gap-fill test with an "absent → unchanged" assertion**

In the test `"does not append new-implementation git instructions for gap-fill runs"`, after the line `expect(capturedPrompt).not.toContain("Pipeline-owned Git and PR handling");`, add:

```ts
    expect(capturedPrompt).not.toContain("Operator instruction for this run");
```

- [ ] **Step 3: Write the failing "instruction present" test**

In `src/__tests__/run-autonomous.test.ts`, add a new test immediately after the `"does not append new-implementation git instructions for gap-fill runs"` test:

```ts
  it("threads a non-empty operator instruction into the gap-fill prompt as an authoritative block", async () => {
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION", "fix the implementation, do NOT weaken the test");

    let capturedPrompt: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPrompt = ctx.data.implementationPrompt;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-prompt", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedPrompt).toContain("Operator instruction for this run (authoritative)");
    expect(capturedPrompt).toContain("fix the implementation, do NOT weaken the test");
    expect(capturedPrompt).toContain("Gap-fill run");
  });
```

- [ ] **Step 4: Run the new test to verify it fails**

Run: `npm test -- run-autonomous`
Expected: FAIL on the new test — `expect(capturedPrompt).toContain("Operator instruction for this run (authoritative)")` (the block is not produced yet).

- [ ] **Step 5: Add the `appendOperatorInstruction` helper**

In `src/run-autonomous.ts`, immediately after the closing brace of `appendPipelineOwnedGitInstructions` (currently ends at line 103), add:

```ts
function appendOperatorInstruction(prompt: string, instruction: string | null): string {
  if (!instruction) return prompt;
  return `${prompt.trimEnd()}

## Operator instruction for this run (authoritative)

The operator triggered this run with the instruction below. Treat it as the authoritative
directive for this run: if it conflicts with the default gap-fill behavior above, follow
this instruction.

${instruction}`;
}
```

- [ ] **Step 6: Read the env var**

In `src/run-autonomous.ts`, after `const prNumber = process.env.PR_NUMBER ?? "";` (currently line 122), add:

```ts
  const commentInstruction = optionalEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION");
```

- [ ] **Step 7: Wire the append after the git-instructions append**

In `src/run-autonomous.ts`, find the line (currently 172):

```ts
  implementationPrompt = appendPipelineOwnedGitInstructions(implementationPrompt, prNumber);
```

Add directly below it:

```ts
  implementationPrompt = appendOperatorInstruction(implementationPrompt, commentInstruction);
```

- [ ] **Step 8: Run the runner tests to verify they pass**

Run: `npm test -- run-autonomous`
Expected: PASS (new "instruction present" test passes; the extended gap-fill test still passes with the "absent → unchanged" assertion).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no output / exit 0).

- [ ] **Step 10: Commit**

```bash
git add src/run-autonomous.ts src/__tests__/run-autonomous.test.ts
git commit -m "feat(runner): thread /ai-implement operator instruction into gap-fill prompt

AII-172. Reads AI_IMPLEMENT_COMMENT_INSTRUCTION and appends an authoritative
operator-instruction block to the gap-fill prompt; absent/empty leaves the
prompt unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Workflow prefix-matcher + plumbing (both `comment-trigger.yml` copies)

**Files:**
- Modify: `src/__tests__/workflow-shim-structure.test.ts` (test at lines 203–208)
- Modify: `workflows/comment-trigger.yml` (Check trigger step ~51–61; `outputs:` ~39–49; implement env ~242–253; run block ~254–260)
- Modify (via `cp`): `.github/workflows/comment-trigger.yml`

**Interfaces:**
- Consumes: nothing from Task 1 at the YAML layer; produces the `AI_IMPLEMENT_COMMENT_INSTRUCTION` env var that Task 1's runner reads.
- Produces: check-trigger job output `comment_instruction` (base64 of the trimmed remainder).

- [ ] **Step 1: Replace the exact-match assertion in the shim-structure test**

In `src/__tests__/workflow-shim-structure.test.ts`, replace the entire test block at lines 203–208:

```ts
  it("comment trigger only runs implementation for an exact trimmed /ai-implement command", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).not.toMatch(/contains\([^)]*\/ai-implement/);
    expect(yaml).toMatch(/body\.trim\(\) === "\/ai-implement"/);
    expect(yaml).toMatch(/if:\s*needs\.check-trigger\.outputs\.matched == 'true'/);
  });
```

with:

```ts
  it("comment trigger fires on a /ai-implement prefix and passes the remainder as an instruction", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    // Anchored prefix match — not a `contains()` check and not exact-equality.
    expect(yaml).not.toMatch(/contains\([^)]*\/ai-implement/);
    expect(yaml).not.toMatch(/body\.trim\(\) === "\/ai-implement"/);
    expect(yaml).toContain("/^\\/ai-implement(?:\\s+([\\s\\S]*))?$/");
    expect(yaml).toMatch(/if:\s*needs\.check-trigger\.outputs\.matched == 'true'/);
    // Remainder is base64-encoded and plumbed through to the runner.
    expect(yaml).toContain('Buffer.from(instruction, "utf-8").toString("base64")');
    expect(yaml).toMatch(/comment_instruction:\s*\$\{\{\s*steps\.trigger\.outputs\.comment_instruction\s*\}\}/);
    expect(yaml).toMatch(/COMMENT_INSTRUCTION_B64:\s*\$\{\{\s*needs\.check-trigger\.outputs\.comment_instruction\s*\}\}/);
    expect(yaml).toContain('export AI_IMPLEMENT_COMMENT_INSTRUCTION=$(echo "$COMMENT_INSTRUCTION_B64" | base64 -d)');
  });
```

- [ ] **Step 2: Run the shim test to verify it fails**

Run: `npm test -- workflow-shim-structure`
Expected: FAIL on the edited test — the unchanged `workflows/comment-trigger.yml` still contains `body.trim() === "/ai-implement"` and lacks the new plumbing strings.

- [ ] **Step 3: Rewrite the "Check trigger command" step**

In `workflows/comment-trigger.yml`, replace the `script: |` body of the *Check trigger command* step (lines 55–61):

```yaml
          script: |
            const body = context.payload.comment.body ?? "";
            const matched = body.trim() === "/ai-implement";
            core.setOutput("matched", matched ? "true" : "false");
            if (!matched) {
              core.info("Ignoring comment because it is not exactly /ai-implement");
            }
```

with:

```yaml
          script: |
            const body = (context.payload.comment.body ?? "").trim();
            const m = body.match(/^\/ai-implement(?:\s+([\s\S]*))?$/);
            const matched = m !== null;
            core.setOutput("matched", matched ? "true" : "false");
            if (!matched) {
              core.info("Ignoring comment: does not start with /ai-implement");
              core.setOutput("comment_instruction", "");
            } else {
              const instruction = (m[1] ?? "").trim();
              // base64 so an arbitrary / multi-line instruction survives the job output,
              // mirroring the issue_description_b64 technique used elsewhere in this workflow.
              core.setOutput("comment_instruction", Buffer.from(instruction, "utf-8").toString("base64"));
            }
```

- [ ] **Step 4: Add the `comment_instruction` job output**

In `workflows/comment-trigger.yml`, in the `check-trigger` job `outputs:` block, add a line directly after `matched: ${{ steps.trigger.outputs.matched }}` (line 40):

```yaml
      comment_instruction: ${{ steps.trigger.outputs.comment_instruction }}
```

- [ ] **Step 5: Pass the encoded instruction as env to the runner step**

In `workflows/comment-trigger.yml`, in the *Run pipeline (gap-fill)* step `env:` block, add a line directly after `RUNNER_PHASE: gap-analysis` (line 246):

```yaml
          COMMENT_INSTRUCTION_B64: ${{ needs.check-trigger.outputs.comment_instruction }}
```

- [ ] **Step 6: Decode it in the run block**

In `workflows/comment-trigger.yml`, in the *Run pipeline (gap-fill)* `run:` block, add a line directly after `export ISSUE_DESCRIPTION=$(echo "$ISSUE_DESCRIPTION_B64" | base64 -d)` (line 259):

```bash
          export AI_IMPLEMENT_COMMENT_INSTRUCTION=$(echo "$COMMENT_INSTRUCTION_B64" | base64 -d)
```

(The line that follows it remains `/opt/ai-implement/entrypoint.sh`.)

- [ ] **Step 7: Mirror the file byte-for-byte to `.github/workflows/`**

Run:

```bash
cp workflows/comment-trigger.yml .github/workflows/comment-trigger.yml
```

- [ ] **Step 8: Run the shim test to verify it passes**

Run: `npm test -- workflow-shim-structure`
Expected: PASS — the edited prefix-matcher test passes, the byte-for-byte identity test passes, and the unchanged auth/meta-eval tests still pass.

- [ ] **Step 9: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS (whole suite green).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add workflows/comment-trigger.yml .github/workflows/comment-trigger.yml src/__tests__/workflow-shim-structure.test.ts
git commit -m "feat(comment-trigger): match /ai-implement prefix and forward the instruction

AII-172. The trigger now fires when a comment starts with /ai-implement and
base64-forwards the trailing text via a comment_instruction job output ->
COMMENT_INSTRUCTION_B64 -> AI_IMPLEMENT_COMMENT_INSTRUCTION. Auth gate and
ISSUE_META eval allowlist unchanged. Both workflow copies stay byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Document the behavior + final verification

**Files:**
- Modify: `CLAUDE.md` (the comment-trigger / gap-fill section — search for `/ai-implement` on a PR kicks off a gap-fill run)

- [ ] **Step 1: Add a CLAUDE.md note**

In `CLAUDE.md`, locate the bullet in the Workflow templates section reading:

```
- **Comment trigger** — `/ai-implement` on a PR kicks off a gap-fill run
```

Replace it with:

```
- **Comment trigger** — a PR comment that **starts with** `/ai-implement` kicks off a gap-fill run. Any text after the token (single- or multi-line) is forwarded to the run as an **authoritative operator instruction**: it is base64-passed through a `comment_instruction` workflow output to `AI_IMPLEMENT_COMMENT_INSTRUCTION`, and the runner appends it to the gap-fill prompt as an "Operator instruction for this run" block that takes precedence over the default gap-fill behavior where they conflict. Bare `/ai-implement` behaves exactly as before. `/ai-implementfoo` and comments that merely contain the token mid-text do not fire. Takes effect only after the target repo re-syncs `comment-trigger.yml` and runs an updated runner image.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm test`
Expected: PASS (whole suite green).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document /ai-implement <instruction> comment trigger

AII-172.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Operational note (for the PR description, not a code step)

This changes a synced workflow template **and** the runner image. For the behavior to take effect in a target repo:
1. Re-sync `comment-trigger.yml` to the target repo (Projects → Sync workflows).
2. Run on a rebuilt/published runner image carrying the updated `run-autonomous.ts` (testing → `:next`, production → `:latest`).

Until both land, `/ai-implement <instruction>` will either still be rejected (old workflow) or fire but ignore the instruction (old runner).

## Self-review notes

- **Spec coverage:** matcher prefix + remainder capture (Task 2 §3), base64 round-trip (Task 2 §3,§6), job-output/env plumbing (Task 2 §4,§5), runner authoritative block (Task 1 §5–7), absent-unchanged (Task 1 §2), tests both layers (Task 1 §3, Task 2 §1), byte-identity (Task 2 §7 + shim test), auth/meta-eval untouched (Global Constraints + unchanged tests), docs (Task 3), ops note. All acceptance criteria mapped.
- **No placeholders:** every code/edit step shows concrete content.
- **Type/name consistency:** `appendOperatorInstruction(prompt, instruction)`, `commentInstruction`, `AI_IMPLEMENT_COMMENT_INSTRUCTION`, `COMMENT_INSTRUCTION_B64`, `comment_instruction` used consistently across tasks.
