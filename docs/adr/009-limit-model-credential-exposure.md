# ADR 009: Limit model credential exposure in trusted repositories

**Status:** Accepted

**Date:** 2026-08-18

**Implementation status (updated 2026-10-08, feature head 2f7ba8a):** **Partially enforced.** The boundaries below are in the source and covered by synthetic tests that need no real credentials. The private run envelope ([AII-680](https://linear.app/eudoxus/issue/AII-680/make-the-run-envelope-private-isolate-credentials-and-enforce-the-gha), [ADR 032](032-private-run-envelope-and-credential-bootstrap.md)) and the runner-side bootstrap isolation ([AII-951](https://linear.app/eudoxus/issue/AII-951/isolate-model-bootstrap-from-repository-processes)) are merged. The orchestrator can seal the Fly bootstrap and the Fly builder has an opt-in protected mode ([AII-500](https://linear.app/eudoxus/issue/AII-500/fly-session-machines-pass-anthropic-api-key-and-claude-code-oauth)); dispatch does not call it yet ([AII-958](https://linear.app/eudoxus/issue/AII-958/wire-preparation-and-authentication-into-managed-dispatch)), so legacy Fly runs still receive plaintext Claude credentials in Machine env. The selected model credential still reaches Claude Code and anything it spawns.

| Boundary | Enforced by | Covered by |
|---|---|---|
| Repo-owned processes (install, setup, verify, teardown) never see model credentials | `repoProcessEnv` in `src/pipeline/process-env.ts` | `src/__tests__/process-env.test.ts` |
| The model process never sees runner callback tokens, `NPM_TOKEN` or forwarded secrets; GitHub write tokens only on gap-fill | `modelProcessEnv` (same file) | `src/__tests__/process-env.test.ts` |
| By default, Git subprocesses get no runner token, model credential, install credential, forwarded secret or dependency-helper variable; each operation's credential is passed as `extra`. Exception: the explicit `targetDir`/`targets` dependency clone/fetch network operations in `clone.ts` use `gitDependencyProcessEnv`, which restores only what the registered git-credential-helper needs — `GIT_DEPENDENCY_TOKEN_FILE` (the cache handle), `GIT_DEPENDENCY_CALLBACK_URL` and the `RUN_PROGRESS_TOKEN` bearer. `COMPOSER_AUTH` is never restored, and local (non-network) Git operations stay fully stripped | `gitProcessEnv` and `gitDependencyProcessEnv` (same file), used by `clone.ts`, `install-skills.ts`, `reference-repos.ts` (the last two use `gitProcessEnv` only) | `process-env.test.ts`, `steps-clone.test.ts` |
| Result token is validated (non-consuming preflight), then consumed atomically before any provider call | `handleRunnerResult` in `src/runner-callback.ts`, `verifyRunToken` in `src/runner-token.ts` | `runner-callback.test.ts`, `runner-token.test.ts` |
| Review and post-mortem passes get `Read,Glob,Grep` only: no shell, MCP, skills or delegation; unsafe tool use blocks a retry | `src/pipeline/steps/read-only-tools.ts`, `claude-stream.ts`, `executor.ts` | `read-only-tools.test.ts` |
| Planning may write only Markdown under `ai-output/comments/`; the guard and settings file live outside the workspace and no user, project or local settings load | `src/planning-write-policy.ts`, `src/run-planning.ts` | `planning-write-policy.test.ts`, `planning-callback-guard.test.ts` |
| Fly and local-Docker runs boot with a token scoped to the target repository, with no fallback to the installation-wide token; KG workspaces mint per-repository tokens | `getTargetRepoToken` in `src/index.ts`, `src/token-vending.ts`, `src/kg-refresh.ts` | `publication-token-vending.test.ts`, `dependency-token-vending.test.ts`, `refresh-runner-github-credentials.test.ts`, `fly-machines.test.ts`, `local-docker.test.ts` |

**Protected Fly bootstrap** (opt-in: `protectedModelBootstrap` on `buildSessionMachineConfig`, sealer in `src/model-auth-seal.ts`). The Machine carries an AES-256-GCM sealed grant (AAD binds dispatch and backend) inside `AI_IMPLEMENT_RUN_CONFIG`, plus the safe `AI_IMPLEMENT_MODEL_AUTH_*` dispatch fields. Raw account credentials and session state never enter Machine config; the runner checks them out with the unsealed bearer. The protection key is **distinct from the hosted-session key** and is an injected input to the sealer, never read from the environment there. The builder fails before `createMachine` if the secret is unavailable or partially provisioned, rejects simultaneous legacy credentials and reserved `extraEnv` names, and has no plaintext fallback.

**Limits that still hold.**

- Claude Code receives the model credential, and commands it starts may inherit it.
- Nothing isolates hostile code running as the same OS principal as the runner. The env builders remove variables; they are not a sandbox, and the planning guard is a tool-boundary check, not a filesystem sandbox.
- Repositories and task documents stay trusted, and containers keep normal network access.
- **Trust limit of the protection key.** It reaches Machines as a classic Fly app secret, and classic secrets are **app-wide**: every Machine in the sessions app can read it, including other teams' runs. The seal therefore binds one dispatch and backend, not the app, and does not defend against another Machine in the same app. `processes[].secrets` remapping is not used for protection (it does not apply to classic secrets, AII-488/AII-491), and protected mode never emits `ignore_app_secrets`.
- **Subprocess boundary.** Per AII-951, the names in `PROTECTED_BOOTSTRAP_KEYS` (`AI_IMPLEMENT_RUN_CONFIG`) and `PROTECTED_BOOTSTRAP_PREFIXES` (`AI_IMPLEMENT_MODEL_AUTH_`), plus the model credential and session names, are stripped from repository, model, Git and diagnostic children, so none inherits bootstrap material. This removes variables; it is not a sandbox, and hostile code running as the same OS principal as the runner is still out of scope.

**Ancestry.** Verified on the full history of `ai-implement/feature/aii-846` (2bfc8a6) with `git merge-base --is-ancestor`; each merge commit below is an ancestor of the branch head.

| Issue | Merge commit |
|---|---|
| AII-854 (Git subprocess env) | 5410d48 (#774) |
| AII-985 (cached dependency credentials) | 692bb13 (#777) |
| AII-855 (result-token validation) | 84c8dcd (#778) |
| AII-988 (credential-client env and disposal) | ad972ec (#779) |
| AII-853 (Fly/local boot token) | 5f81aed (#781) |
| AII-990 (KG boot tokens) | 0c9be34 (#782) |
| AII-986 (read-only reviewer tools, conservative retry) | 99299af (#784) |
| AII-987 (planning write policy) | 56a28cd (#788) |

AII-852 is the umbrella for 986 and 987 and has no commit of its own.

**Evidence (2026-09-30, Node 24, no real credentials).** `npm run typecheck` passed. The 13 test files in the table above passed (468 tests), and the full `npm test` passed (256 files, 7677 tests). Remote CI status was not readable from this environment and must be confirmed on the PR before roll-up.

---

## Context

The current runner passes its process environment to repository setup and verification hooks. That environment can contain `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. A repository command could read or transmit the model credential.

Claude Code also receives the credential and can start shell commands. Anthropic does not document a supported way to guarantee that these child commands cannot access the credential. The first local release cannot honestly claim isolation from hostile repository code without a different credential-broker and command-sandbox design.

Local runs need network access for the model provider and, when required, package registries. Removing all network access would prevent common setup and test workflows.

## Decision

The first local release supports trusted repositories and trusted task documents only. The quickstart states this boundary before the first run.

AI-Implement removes the model credential from repository setup, test, verification, and teardown processes that it starts directly. Claude Code receives the credential. Commands started by Claude Code may inherit it.

Repository commands keep normal container network access in version one. The container receives no host Docker socket. It does receive a GitHub token, scoped to the target repository (see the status table). The selected repository mount is read-only, and all modifications happen in the isolated working copy.

## Alternatives considered

- **Pass the full runner environment to every AI-Implement child process** — rejected because setup and test code do not need the model credential.
- **Disable container networking** — rejected because the model call and common dependency installation need network access.
- **Claim isolation from hostile repository code** — rejected because the current Claude Code process model cannot support that guarantee.
- **Build a credential broker and command sandbox now** — deferred because it materially expands the local release and needs a separate security design.

## Consequences

The runner needs separate environment builders for the model process and AI-Implement-owned repository commands. Tests must prove that setup, test, verification, and teardown processes started by AI-Implement cannot read either supported model credential.

Users must treat repository code and task documents as trusted, network-capable inputs. The quickstart and security notes must state this boundary.
