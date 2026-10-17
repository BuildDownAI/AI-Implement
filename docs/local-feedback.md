# Local feedback

Local feedback is the manual gate for the local runner path. It runs from an
AI-Implement checkout, builds or verifies the local runner image from that
source, and exercises the production runner entrypoint before anyone runs a
live account smoke.

The default run is synthetic. It must not call a paid model provider, read host
model credentials, require GitHub, contact a tracker, or call the orchestrator.
Use it first every time.

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
cd "$AI_IMPLEMENT_DIR"

npm run local:feedback
```

If your shell already carries local runner or provider credentials, remove them
for the synthetic gate. The command fails closed when protected names are
inherited.

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
cd "$AI_IMPLEMENT_DIR"

env -u CLAUDE_CODE_OAUTH_TOKEN \
  -u RUNNER_CALLBACK_BASE_URL \
  -u RUNNER_TOKEN_SECRET \
  npm run local:feedback
```

By default, artifacts are written under an operating-system temp directory. Use
`--artifacts-dir` when you want a predictable location. The directory must be
empty so proof cannot reuse stale output.

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
ARTIFACTS_DIR="${TMPDIR:-/tmp}/ai-implement-manual-proof-synthetic-$(date +%Y%m%dT%H%M%S)-$$"

cd "$AI_IMPLEMENT_DIR"
npm run local:feedback -- --artifacts-dir "$ARTIFACTS_DIR"
```

The synthetic run should record:

- the source commit and dirty diff used for the fresh image build
- the runner image ID
- the Node version and real Codex CLI version from the image
- the configured planning, implementation, and review stages
- production entrypoint evidence for `RUNNER_PHASE=full`
- planning, implementation, and review outcomes
- the API transport proof from the internal fixture peer
- the simulated subscription ownership proof

The command writes `summary.md` and `result.json` in the artifact directory. A
successful synthetic run also writes its gate marker under the operating-system
temp directory, outside the checkout.

The subscription proof in the default run is a simulation of ownership and lock
handling. It is not proof that a real ChatGPT/Codex account can authenticate.

Inspect the latest run:

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
cd "$AI_IMPLEMENT_DIR"

RUN_DIR="$(
  ls -td "${TMPDIR:-/tmp}"/bd-local-feedback-* 2>/dev/null |
    while IFS= read -r proof_candidate; do
      if [ -f "$proof_candidate/result.json" ]; then
        printf '%s\n' "$proof_candidate"
        break
      fi
    done
)"

sed -n '1,220p' "$RUN_DIR/summary.md"
jq . "$RUN_DIR/result.json"
git status --short
git diff
```

If you used `--artifacts-dir`, inspect that directory instead:

```bash
RUN_DIR="$ARTIFACTS_DIR"

sed -n '1,220p' "$RUN_DIR/summary.md"
jq . "$RUN_DIR/result.json"
```

Failure is valid when Docker is unavailable, the runner image cannot be built,
the Codex binary is missing, the source state cannot be proven, or the pinned
versions cannot be read. These should fail the command instead of becoming green
skips.

## Agent-driven check

An agent can run the same synthetic gate without host credentials. Use a unique
artifact directory and keep the same environment cleanup as the manual synthetic
command.

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
ARTIFACTS_DIR="${TMPDIR:-/tmp}/ai-implement-manual-proof-agent-$(date +%Y%m%dT%H%M%S)-$$"

cd "$AI_IMPLEMENT_DIR"
env -u CLAUDE_CODE_OAUTH_TOKEN \
  -u RUNNER_CALLBACK_BASE_URL \
  -u RUNNER_TOKEN_SECRET \
  npm run local:feedback -- --artifacts-dir "$ARTIFACTS_DIR"
```

Inspect it the same way:

```bash
sed -n '1,220p' "$ARTIFACTS_DIR/summary.md"
jq . "$ARTIFACTS_DIR/result.json"
```

The artifacts should show the source commit, dirty diff, image ID, Node version,
Codex CLI version, stage choices, API transport outcome, simulated ownership
outcome, and final run outcome. They should not contain host credential paths,
bearer tokens, `CODEX_HOME`, `OPENAI_API_KEY`, copied session data, or a public
environment capture with model credentials.

## Live account smoke

Run the live path only after the synthetic gate passes from the same source
state. The live run must use the same source `HEAD`, tracked diff, and gated
image recorded by the prior synthetic run. The live path is explicit and manual:

```bash
npm run local:feedback -- \
  --live \
  --agent-config "$AGENT_CONFIG" \
  --workspace "$TARGET_REPO" \
  --task "$TASK_FILE"
```

Use a dedicated ChatGPT plan record for this smoke. Keep the record and the agent
config outside both the target repository and artifact directory. The record
is written by the sign-in command, not by Codex:

```bash
npm run build
install -d -m 700 "$HOME/.ai-implement/chatgpt-plan"
node dist/chatgpt-plan-login.js login --record ~/.ai-implement/chatgpt-plan/credentials.json
```

The host refreshes the access token when it has less than 55 minutes left and
writes the rotated record back atomically before the container sees anything. The
container receives only `CHATGPT_PLAN_ACCESS_TOKEN`; the refresh token and ID
token stay on the host, and no `auth.json` is created. If the sign-in expires,
the run fails with `authentication_required`; run `login` again.

A `codex-subscription` profile must use `"sessionSource": "chatgpt-sign-in"`;
any other source fails config load with `config_invalid`. Sign in again with
`node dist/chatgpt-plan-login.js login`. The harness refuses a record that is
Codex's active `auth.json`.

Create an external stage-agent config. This example writes only file references;
it does not embed credential material.

```bash
AI_IMPLEMENT_PRIVATE_DIR="$HOME/.ai-implement-local-feedback"
AGENT_CONFIG="$AI_IMPLEMENT_PRIVATE_DIR/agent-config.json"
TARGET_REPO="$HOME/src/private-target-repo"
MODEL_NAME="<chosen-supported-model>"
install -d -m 700 "$AI_IMPLEMENT_PRIVATE_DIR"

# Must exactly match the target repository's GitHub origin owner/repo.
PROJECT_KEY="owner/private-target-repo"

export AGENT_CONFIG PROJECT_KEY MODEL_NAME

node <<'NODE'
const fs = require("node:fs");
const configPath = process.env.AGENT_CONFIG;
const projectKey = process.env.PROJECT_KEY;
const model = process.env.MODEL_NAME;
const sessionPath = `${process.env.HOME}/.ai-implement/chatgpt-plan/credentials.json`;
const stage = {
  agent: "codex",
  provider: "openai",
  model,
  accountProfileId: "local-codex",
  invocationTimeoutMs: 1800000
};
const config = {
  version: 1,
  mode: "configured",
  projectKey,
  stages: {
    planning: stage,
    implementation: stage,
    review: stage
  },
  profiles: [{
    id: "local-codex",
    identity: "local-feedback-codex",
    revision: 1,
    agent: "codex",
    provider: "openai",
    authMode: "codex-subscription",
    sessionPath,
    sessionSource: "chatgpt-sign-in",
    trustedPrivateTesting: true
  }]
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

chmod 600 "$AGENT_CONFIG"
```

Before running with subscription credentials, verify the target repository is
private or internal with GitHub CLI. This check is separate from AI-Implement and
does not require tracker or orchestrator access:

```bash
OWNER_REPO="$(jq -r .projectKey "$AGENT_CONFIG")"
gh repo view "$OWNER_REPO" --json visibility
```

Then run the live smoke:

```bash
AI_IMPLEMENT_DIR=/private/tmp/aii-939-manual-testing
TASK_FILE="$HOME/ai-implement-local-feedback/task.md"
ARTIFACTS_DIR="${TMPDIR:-/tmp}/ai-implement-manual-proof-live-$(date +%Y%m%dT%H%M%S)-$$"

cd "$AI_IMPLEMENT_DIR"

npm run local:feedback -- \
  --live \
  --agent-config "$AGENT_CONFIG" \
  --workspace "$TARGET_REPO" \
  --task "$TASK_FILE" \
  --artifacts-dir "$ARTIFACTS_DIR"
```

When the run finishes, `summary.md` reports `mode: live` and the outcome from the
harness exit code, matching `result.json`. A summary that still says
`mode: live-preflight` means the command stopped before the run finished.

Use a clean target checkout. If a cancelled or failed run leaves a session lock
held for the same session file, inspect the artifact directory before trying
again. A partial artifact set should still show the source proof, image proof,
selected stages, and the step where execution stopped.

### Cancelled runs and the session lock

On SIGINT/SIGTERM the harness stops the container, closes the credential bridge (draining in-flight
checkouts), probes Docker, and then settles the lease. It prints one line, `[dev:run] local session lease:
released` or `held (<category>)`; the line never carries a lock token, a path, or session values.

- **released** — no disposition arrived, but the lease was provably unused (no checkout, no refresh) and
  Docker confirmed the container is gone. Ownership's `releaseUnused` made that call and removed the lock.
- **held** — the lease was used or refreshed, the owner is stale, or termination was not confirmed. The
  lock stays as it is; a held run is never reported as success. `telemetry.json` keeps `exitCode` as the
  Docker exit (`null` when unknown) and adds `cancelled: true` with `cancellation.logicalExit: 130`, so exit
  `0` plus a cancellation is not a successful run.

A used lock from a killed runner stays `state: owned` with no hold reason. Do not clear it from the filename
or age alone. Before removing it, confirm all of: the container is gone (`docker ps -a` shows no container for
the run), no runner process for that session is alive, and the session record is intact and was persisted
(a refreshed session may exist only in the container's lost state — if in doubt, re-login rather than
reuse). Only then remove that one `.ai-lock` file by hand. The harness never does this automatically.

## Hosted Codex job in local Docker

`npm run dev:local` can launch an implementation run of an opted-in project in local Docker with a
`codex-subscription` profile. The run config and every model-auth value (the plain `local` grant bearer,
`AI_IMPLEMENT_MODEL_AUTH_*`) travel only in the 0600 env file passed with `--env-file`, never in `docker run`
arguments; the file is deleted after the launch attempt. `docker inspect` still shows the values, which is
acceptable for local development. Opted-out projects keep today's arguments and need an Anthropic credential.

1. Opt the project in with direct store writes: save the account profile revision and the orchestrator
   defaults with `src/agent-config-store.ts` (`saveAccountProfileRevision`, `setOrchestratorDefaults`), then
   call `setProjectOptIn("<TEAM>", true)`. The target repository must be private.
2. Import a plan record for the profile with `src/model-account-cli.ts` (see the earlier sections).
3. Run `npm run dev:local`. The container reaches the model-auth routes at
   `config.localRunnerOrchestratorUrl ?? config.runnerCallbackBaseUrl ?? http://host.docker.internal:<healthPort>`.
   The local transport gate trusts plain HTTP from the container.

A mapping `extraEnv` entry named `AI_IMPLEMENT_RUN_CONFIG`, `AI_IMPLEMENT_MODEL_AUTH_*` or a model credential
name (for example `OPENAI_API_KEY`) fails the dispatch before launch and releases the admission.
