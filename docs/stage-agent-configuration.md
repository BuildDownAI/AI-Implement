# Stage agent configuration

Stage agent configuration decides, for each stage of a run, which agent runs, through which provider, on which model, with which account's credential. A configured project uses it; a legacy project runs on the legacy path, which reads the model credential from the target repository's secrets or the orchestrator's environment.

## Stages and selections

There are three stages: `planning`, `implementation` and `review` (`STAGE_NAMES`, `src/agent-config.ts`). Each stage resolves to one selection: `agent` (`claude` or `codex`), `provider` (`anthropic`, `bedrock`, `openrouter` or `openai`), `model`, `accountProfileId` and `invocationTimeoutMs`.

## Account profiles

An account profile is a named account an operator creates on Models & providers. Its revisions are immutable (`model_account_profile_revisions`): each change saves a new revision. A profile has an agent, a provider, an auth mode (`anthropic-api-key`, `openai-api-key`, `openrouter-api-key`, `bedrock`, `codex-subscription`, `claude-subscription`) and a status (`active`, `disabled`, `archived`). Every active profile is usable by every project. Its credential lives encrypted on the orchestrator; a profile names it by `credentialRef`, and no read returns it. See [model-account-operations.md](model-account-operations.md).

## Defaults, overrides and the account list

A new project starts configured when the orchestrator stage defaults are on and no project configuration row already exists. Existing projects keep their mode, including projects deleted and created again. With defaults off or absent, new projects start legacy; if configuration cannot resolve, the mapping still saves in legacy mode with a warning. Environment-seeded mappings remain legacy. For configured projects, the stage defaults select the models, not the repository's model files. Until a new project's workflow sync pull request merges, dispatch starts no run for it and the ticket gets the "Managed dispatch refused" comment.

The orchestrator holds the default configuration, and each project may override it field by field (`stage_agent_config_revisions`, every write a new revision). In the defaults, each stage can hold an ordered list of account entries, `accounts: [{ accountProfileId, model }]`. The first entry supplies the stage's initial account; the later entries are candidates for fallbacks. An entry's agent and provider come from its profile, and a blank model means the first entry's model. The first entry must have a nonblank model. When both flat fields and `accounts` are supplied, the first account's profile and model take precedence. A stage with a single entry is stored in the flat shape (`agent`, `provider`, `model`, `accountProfileId`), for rollback compatibility. Configuration version remains 1.

On Models & providers, the Orchestrator stage defaults card edits this list with Add account, Remove, Move up and Move down controls. Each row selects an active profile by Name and ID and supplies its model; row 1 supplies the stage model. A later model may be blank only for the same agent as row 1. Save displays server validation errors and keeps unsaved edits. A project that overrides the account profile on its Agents tab uses these defaults as fallbacks after its project account.

- Projects do not store a list. A project that overrides `accountProfileId` runs with its project account first, followed by the defaults in order without repeating that profile. Blank default models inherit the first default model, not the project model. Defaults that would move from a subscription to paid API use are omitted. A project that overrides other fields keeps the default's fallbacks.
- `invocationTimeoutMs` and `fallbackModel` are stage fields, merged field by field.

A project account that does not resolve is refused at save; the default accounts after it are fallbacks for a failure during a run. Saving refuses an entry that does not resolve, a profile listed twice, an entry of another agent with a blank model, and an API-key or Bedrock entry after a subscription entry: a run never moves from subscription use to paid API use by itself. Errors name the stage and account index (starting at zero). The local harness uses these same rules for `stages`; its project-like `selections` block refuses lists.

The Projects Agents tab has no mode control. It shows the project mode and names the admin tool `set_project_agent_mode` for changing it. Stage overrides and their save button remain available for both modes; saves send only `stages`. Legacy runs ignore stored overrides until the project becomes configured. Unsaved projects show “Save the mapping first”.

`PUT /api/mappings/:key/agent-config` inspects readiness for a configured project, so a new configured project receives `409` when saving stage overrides until its workflow sync pull request merges.

## Run preparation and the snapshot

When a run is prepared (`prepareAgentRun`, `src/agent-run-preparation.ts`, called inside the ImplementationRun prelaunch), `chooseStageAccount` takes each stage's first entry that passes the configuration checks (its profile resolves, and its backend is supported) and lists the later passing entries as fallbacks. When a project overrides `accountProfileId`, entry zero must pass its check or resolution fails with its reason; defaults cannot replace a failed project account. Without that override, selection can skip failed defaults. Bedrock is supported only on GitHub Actions. The chosen entries become the run's snapshot, stored once per dispatch in `run_agent_config_snapshots` and never updated; a retried preparation reuses it. Beside it, `resolved_config_json` records per stage the chosen index, each entry passed over with its reason, and the fallback list, including profile revision and auth mode. Before freezing a new dispatch, preparation checks fallback credentials using each entry's own provider, profile revision and auth mode. Unready fallbacks are dropped without refusing the run; `droppedAccountFallbacks` records profile ids and safe reason codes in `resolved_config_json`, and grants include only retained entries. Reserved subscription sessions are verified at checkout under their owner generation. The binding budget may also trim the fallback list. Repeated preparation reuses the frozen list and grant. Primary credential failures still stop preparation. When no entry passes, the run fails with the first entry's failure.

During implementation and review, `ACCOUNT_USAGE_LIMIT`, `PROVIDER_AUTH` and `PROVIDER_CONFIG` move the run to the next unused fallback account, preserving partial work. After exhaustion, the last failure code is reported; auth/config failures retain the provider’s message. Transient provider failures keep their retry and model-fallback behavior. Planning uses its existing overload model fallback and does not rotate accounts.

The primary credential is checked after the choice. A missing or unreadable primary credential fails the run as `authentication-required` and never moves the run to the next entry. Runner delivery and switching accounts during a run are separate work.

## Where to see it

`get_tenant_health` reports `stageAgents`: the orchestrator's stored `defaultsMode`
and each mapped project's `teamKey` and `agentMode` (`configured` or `legacy`).
Projects are sorted by ascending team key. Missing defaults or project rows mean
`legacy`; no mappings produces an empty project array, and unmapped project rows
are omitted. The tool reads these modes from SQLite and exposes no runner environment values.

`GET /api/mappings/:key/agent-config/resolved` shows each stage's entries in order, whether each passes the configuration checks now, and the reason when it does not. It also shows whether a project account override has no remaining default entries after it. These diagnostics check profile compatibility and support on the project's current dispatch backend(s). Preparation checks the backend of its actual request. If a stage cannot form a complete selection, its entries are empty and the route preserves the structured resolution error. The Reports page shows the profile each invocation used.

## Configured agent environment

`SAFE_CONTEXT_KEYS` in `src/model-auth-client.ts` is the source for the exact environment names a configured agent inherits:

- Runner context: `CI`, `GITHUB_ACTIONS`.
- Process context: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TMP`, `TEMP`, `TZ`.
- Locale: `LANG`, `LANGUAGE`, `LC_ALL`, `LC_COLLATE`, `LC_CTYPE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `LC_ADDRESS`, `LC_IDENTIFICATION`, `LC_MEASUREMENT`, `LC_NAME`, `LC_PAPER`, `LC_TELEPHONE`.
- Certificate locations: `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`.
- Proxies: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`, `all_proxy`.

Values are copied unchanged only when supplied by the runner, including empty strings. Missing or undefined values remain absent; no default `CI` or `GITHUB_ACTIONS` value is set. Other `GITHUB_*` and `ACTIONS_*` names are dropped, including `GITHUB_REPOSITORY`, `GITHUB_ENV` and `ACTIONS_RUNTIME_TOKEN`.

Protected names, forwarded secrets and the credential/routing strip lists take precedence over this allowlist. A forwarded secret named `CI` is therefore removed, as are inherited credentials such as `GITHUB_TOKEN`. After filtering, the selected account's authentication values are supplied separately for its auth mode.


The admin tool `set_project_agent_mode` changes a project's mode to `configured` or
`legacy`. It inspects nothing: no workflow readiness, account check or GitHub read.
It validates configuration resolution when moving to configured and keeps stored stages.
The orchestrator log records the cause of a `resolution-failed` answer.
A repeated request for the current mode adds no row. In-flight runs keep their stored
snapshot; the new mode applies to the next dispatch. A project with a stored row is
moved by this tool, not by `adopt-projects`.

Dispatch gates configured runs. When a configured project is not ready, dispatch starts
no run. The ticket gets "Managed dispatch refused (configuration-error): <code>. No run
was started." with the prefix "Planning failed:" or "Implementation failed:".
Repeated refusals count as dispatch failures and park the issue at the limit.
Recover by setting the project to legacy, or by merging the workflow sync pull request
and removing the park.

OpenRouter profiles use provider `openrouter` and auth mode `openrouter-api-key` with either `claude` or `codex`, on every backend. Create the profile through `POST /api/model-accounts` and store its write-only key through `PUT /api/model-accounts/:id/credential`. OpenRouter is a paid API mode, so it cannot follow a subscription in an account list. Runner support is delivered separately; until then, runs fail closed with `unsupported_auth_mode`.
