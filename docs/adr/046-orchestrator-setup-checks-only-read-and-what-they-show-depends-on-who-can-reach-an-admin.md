# 046. Orchestrator setup checks only read, and what they show depends on who can reach an admin

**Status:** Accepted. The result contract and the orchestrator's own checks land with [AII-1532](https://linear.app/eudoxus/issue/AII-1532); the surfaces in decisions 2 and 3 land with later children of [AII-1531](https://linear.app/eudoxus/issue/AII-1531).
**Date:** 2026-10-23
**References:** ADR 015, ADR 022, [orchestrator-configuration.md](../orchestrator-configuration.md), [access-model.md](../access-model.md), [deployment.md](../deployment.md) § "The health body (`GET /`)", [mcp-server.md](../mcp-server.md)

## Context

A self-hosted orchestrator's setup spans its own environment, a GitHub App and its installation, a tracker, each target repository, a runner backend and model credentials. At boot, `loadConfig` (`src/index.ts`) requires only the GitHub App credential pair, and it checks that pair, like every other value, for presence alone. No credential is exercised until a poll or a run first uses it, so a wrong value fails late and often silently. The orchestrator setup checks (`src/setup-checks/`) find those failures before a real issue does, and again when setup drifts.

Three properties of the checks need a rule, because each is easy to get wrong in a way that harms the deployment the checks protect:

- **They run unattended and often**: on a schedule, after saves, and when a runtime failure names one. Anything a check does, it does repeatedly, in systems the customer owns.
- **Their results map where a deployment is weak**, and the surfaces that could carry them have different audiences:
  - `GET /` answers anyone.
  - `get_tenant_health` answers every allowlisted identity (ADR 015).
  - The admin API answers admins, plus a `user` on the read routes of a page granted to them (`PAGE_ROUTES`, `src/access-page-grants.ts`).

  Until an admin path is configured, nobody can sign in as an admin. So on a new orchestrator, the one person who can act on the results is the operator who has not yet configured sign-in.
- **They are read when something else is broken.** A check that depends on the subsystem it reports on, or on a document that has since moved, fails exactly when it is needed, and a check that re-reads a value its own way can disagree with what the orchestrator does with it.

## Decision

**1. A check only reads.**
- A fact that only a write can prove reports `cannot-verify`, together with what to check by hand. The model case is whether the Linear app may create a workspace-scoped label.
- Writes happen only in self-heal actions an operator triggers. Those reuse actions the orchestrator already exposes, under their existing roles.

**2. Results are tiered by audience.**

| Surface | Audience | Content |
|---|---|---|
| The admin setup page and its API route | admins, and users granted the page | every check, its detail and its fix |
| `get_tenant_health` | every allowlisted identity | each check's name and state |
| `GET /` | anyone | the count of failing core checks |

A result's `id`, `title` and `state` never carry a configured value, because `get_tenant_health` shows those three fields to every allowlisted identity, and no field ever carries a secret's value.

**3. Bootstrap mode.** While no admin path is configured, `GET /` also names the failing checks on the path to an admin, and only those:
- the GitHub App credential pair;
- the volume;
- Restate;
- the sign-in providers and the redirect base URL;
- an admin address in the allowlist.

An admin path is configured when any of these holds:
- `ADMIN_ACCESS_CODE` is set and is not the published `.env.example` placeholder, which boot refuses (`effectiveAccessCode`, `src/admin-session.ts`); or
- at least one sign-in provider that boot keeps (`resolveProviders`, `src/oauth/providers.ts`) and `OAUTH_REDIRECT_BASE_URL` are set, and the effective allowlist holds an admin address; or
- the BuildDown provider and `OAUTH_REDIRECT_BASE_URL` are set, since its organization role claim admits an organization owner or admin as admin with no allowlist entry (`authorize`, `src/oauth/authorize.ts`).

The test reads configuration only. When the stored allowlist cannot be read, the path counts as configured, so the mode stays off.

Project, tracker and repository checks are never named on `GET /`. Projects are created only by an admin (`POST /api/mappings`, the `add_project` tool), so a new orchestrator has none to name.

**4. Existing health surfaces change only by addition.** Current fields keep their names and meanings, so existing consumers keep working.

**5. A check reports what the orchestrator does, as independently as it can of what it reports on.**
- **It shares the orchestrator's own decision code.** Where the orchestrator decides something from a value (a parse, a precedence, which providers to keep), the decision is a pure function that the orchestrator and the check both call, such as `parsePollIntervalMs`, `resolveRunnerMode`, `resolveProviders` and `SEED_ONCE_SETTINGS`. A decision found inline is extracted first, so the check never parses the value its own way, the two cannot disagree, and a change to the decision changes the check with it.
- **It reads any runtime state through a reader its caller passes in** (`SetupCheckContext`, defined once by `createSetupCheckContext`). The setup command runs in its own process and the `SetupChecks` object inside Restate, so each supplies the readers that are true where it runs; the Restate status has no default for that reason. A reader that throws makes only the checks that call it `cannot-verify`, and the others still report (`runSetupChecks` runs them under `Promise.allSettled`).
- **Its text names only what the code owns**: a variable, an admin page, a log prefix, `fly.toml`. It never names a `docs/` file, which can change or move with nothing noticing. Documentation points at checks instead, by id: the ids are declared once (`SETUP_CHECK_IDS`) and never renamed, since stored runs, runtime failures and self-heal actions name checks by id. A test fails when any check's detail or fix names a `docs/` file.

## Alternatives considered

- **Reversible write probes**, such as creating then deleting a label or a branch. Rejected: every scheduled run would write into customer systems, and a failed delete leaves debris behind.
- **Results for admins only.** Rejected: `user` callers over `/mcp`, the system-questions skill and uptime monitors could not see setup state.
- **Check names on `GET /` always.** Rejected: it publishes the map of a deployment's weak points to anyone who knows its address.
- **Bootstrap mode triggered by an unreachable admin path.** Rejected: an outage would switch public detail on, on an orchestrator that already has projects.
  - An unreadable stored allowlist answers 503 rather than logging admins out ([access-model.md](../access-model.md)).
  - A first sign-in binds through Restate (`bindAccessIdentity`, `src/restate/access-binding.ts`), so a Restate outage denies it.
- **A check that reads module state directly**, such as `getRestateStatus()`. Rejected: the setup command runs in a separate process with no sidecar state, so it would report the sidecar as still starting.
- **A check that parses a value itself.** Rejected: two parses of one variable drift, and the check would then report a state the orchestrator is not in.
- **Check text that links a reference page.** Rejected: the page is maintained on its own schedule, and a renamed or moved section leaves every check that cites it wrong.

## Consequences

- Some setup facts report `cannot-verify` instead of being proven: write permissions that only a write would show, and target-repository secrets the App cannot read. The report says so, which replaces today's silence. It does not replace the fact.
- Anyone who knows an orchestrator's address learns how many of its core checks fail. A new orchestrator also discloses which of its checks on the path to an admin fail.
- A scheduled run spends tracker and GitHub API calls. Its cadence is an operator setting, and the schedule can be off.
- Sharing decision code moved several inline decisions into named functions, and boot now calls them too: the placeholder access code is refused at boot rather than only reported, and boot logs every sign-in provider it drops, including one with only some of its variables set.
