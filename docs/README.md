# docs/

Two tiers, distinguished by what a file *is* rather than what it covers.

**Top-level `docs/*.md` are subsystem references.** Each one is the authority on its subject, and `CLAUDE.md` links to them rather than restating their contents. `CLAUDE.md` is loaded into every Claude invocation, so it stays a lean index of pitfalls and conventions; depth lives here, where it is read on demand. A reference doc is expected to be accurate — it is cited as source of truth, so treat a correction here with the same care as a code change.

**Subdirectories are typed artifacts** — records of decisions and work, not maintained references. They are historical: accurate as of writing, not updated as the code moves.

## Subsystem references

| Document | Covers |
|----------|--------|
| [pipeline-architecture.md](pipeline-architecture.md) | The step contract, the nine built-in steps, how `applyWiring` supplies inputs, and how a fork overrides steps or the pipeline |
| [review-fix-rail.md](review-fix-rail.md) | The finding ledger, the four `review_*` tables, the webhook events that feed the fix queue, and the drain loop |
| [feature-branch-grouping.md](feature-branch-grouping.md) | Parent/child issue grouping, cascade branch creation, and automatic roll-up |
| [workflow-envelope.md](workflow-envelope.md) | The `RunConfigV1` dispatch envelope and the legacy per-field contract |
| [runner-images.md](runner-images.md) | The image resolution ladder, publishing channels, and why a private image constrains the execution mode |
| [kg-sidecar.md](kg-sidecar.md) | The knowledge-graph sidecar, the `/mcp` proxy and its OAuth flow, and the image build |
| [deployment.md](deployment.md) | Deploy paths, client instances, and the AWS Bedrock setup |
| [access-model.md](access-model.md) | Who may sign in and what they may see: the allowlist and its env-to-database handover, the Admin/User split and per-page grants, provider binding, the per-request re-check, the audit trail, and host recovery from lockout |

Two references live outside this directory because they are consumed directly rather than read: `.env.example` is the canonical list of orchestrator environment variables, and `CLAUDE.md` is the index that points at everything here.

## Diagram conventions

Adopted 2026-08-24 (from the AII-424 / PR #327 review):

- **Flow diagrams in rendered markdown use mermaid** (```` ```mermaid ```` blocks). GitHub,
  Linear, and the Mintlify docs site all render it natively — the same source draws everywhere.
- **Validate before committing:** `npx -y @mermaid-js/mermaid-cli -i <file>.mmd -o /tmp/out.svg`.
  A mermaid syntax error renders as an error box, which is worse than ASCII art.
- **Tabular data uses markdown tables**, never a diagram — if the content is rows and columns
  wearing box art, it is a table.
- **ASCII diagrams are reserved for agent-context files** (`CLAUDE.md`), which are consumed as
  raw text every invocation. Everywhere a human sees rendered markdown, mermaid wins.

This applies to `docs/`, tracker issue bodies, and PR descriptions alike.

## Typed artifacts

| Directory | Contents |
|-----------|----------|
| `adr/` | Architecture decision records — a decision, its context, and what was rejected |
| `plans/` | Dated implementation plans and design notes for specific pieces of work |
| `solutions/` | Documented fixes to past problems, filed by category with YAML front matter (module, tags, problem_type) |
| `superpowers/` | Per-issue design specs, plans, and notes, dated and linked to their tracker issue |

## Adding a reference

Add the file at the top level, add a row above, and link it from the relevant section of `CLAUDE.md` with a one-paragraph summary plus **Full reference:**. Follow the pattern the existing entries use: `CLAUDE.md` says what the subsystem is and what its non-obvious pitfalls are; the reference says how it works.

Verify claims against the code as you write, not afterward. These documents are cited as authoritative, and an inaccurate reference is worse than a missing one — the whole point of moving depth out of `CLAUDE.md` was to make it accurate enough to trust.
