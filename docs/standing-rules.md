# Standing rules for design and analysis work

These rules apply to all work on AI-Implement: plans, issues, ADRs, reviews, analysis, and code. They come from the operator (John, 2026-10-02). A plan or an issue that breaks one of them must say so and say why.

## 1. Verify every claim in code before you present it

A claim about how this system behaves is verified before it reaches the operator, an issue body, an ADR, or a doc. "Not verified yet" is not a finding. Do not present a theory as an analysis result.

* **Code behaviour:** open the file and read the function. Cite the path and the symbol. Grep for routes, tables, keys, and settings.
* **Engine or platform behaviour** (Restate, GitHub Actions, Fly): read the vendor documentation, and when the claim decides a design, prove it with a small experiment against the version this repo pins (for Restate: `@restatedev/restate-server` and `@restatedev/restate-sdk` from `package.json`). Record the commands and the result.
* **Infrastructure facts that code cannot show** (an app's Fly organization, an App installation's settings): state them as unverified, name the command or page that verifies them, and do not base a recommendation on them until they are checked.
* A doc, an ADR, a memory, a knowledge-graph hit, or an earlier issue is a lead, not a verification (see the skills repo `plugin/skills/bd-shared/anchor-verification.md`).

If a claim cannot be verified in the session, leave it out of the conclusions and list it under "not verified" with the step that would verify it.

## 2. Do not change or expand the rights a deployment needs

Prefer the design that needs no new right in GitHub, GitHub Actions, or any other customer-side system. A new right means a change at every customer and every running orchestrator, and it is hard to roll out.

Cost order, from the cheapest to the most expensive. Pick the cheapest level that works, and state the level in the plan:

| Level | What changes | Who acts | Reference |
|---|---|---|---|
| 1 | Orchestrator code or runner image only | Nobody outside our deploy | `docs/deployment.md` |
| 2 | A new field inside the `run_config` envelope | Nobody: the synced template already passes the envelope | `docs/workflow-envelope.md` |
| 3 | A change to a synced workflow template (a new `workflow_dispatch` input, a new step, a new `permissions:` entry) | Each target repo merges a sync PR | `docs/workflow-sync.md` |
| 4 | A new GitHub App permission or event subscription, or a repository setting | An org owner at each installation accepts the change | `docs/deployment.md` § "GitHub App permissions", ADR 033 |

A design at level 3 or 4 needs an explicit decision by the operator before it is planned in detail. ADR 033 is the rule for run signals; this rule applies to every feature.

Re-check this rule from time to time. If a level-4 right becomes necessary for many features, decide it once for all of them, not one feature at a time.

## 3. Re-evaluate ADR rules as Restate use grows

Many ADRs record a decision for the context of their date: the first run kind on Restate, one workflow, one signal. As more run kinds move to Restate, that context changes.

* Before a new Restate design relies on an ADR rule, or is blocked by one, read the ADR's **Context** and the reason for each rejected alternative. Check that the reason still holds today, in code or by experiment (rule 1).
* If the reason no longer holds, say so in the plan and add a dated amendment to the ADR. If the reason still holds, a one-line note in the plan is enough.
* A rejected alternative is rejected for its stated reason only. Example: awakeables were removed from kg-refresh because the resolver needed a GitHub App event subscription (`workflow_run`). An awakeable that needs no new right is allowed (ADR 033 and ADR 034, amendments of 2026-10-02).

The Restate-related ADRs today: 017, 018, 023, 025, 030, 031, 032, 033, 034.
