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

RUN_DIR="$(ls -td "${TMPDIR:-/tmp}"/bd-local-feedback-* 2>/dev/null | head -1)"

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

Use a dedicated local Codex profile for this smoke. Do not reuse the active
Codex app profile, and keep the profile and agent config outside both the target
repository and artifact directory. The
[Codex authentication documentation](https://learn.chatgpt.com/docs/auth) states
that `cli_auth_credentials_store = "file"` stores credentials in `auth.json`
under `CODEX_HOME`, and that `codex login --device-auth` supports device-code
login for headless environments.

Create the dedicated profile:

```bash
LOCAL_CODEX_PROFILE_DIR="$HOME/.ai-implement-local-codex-profile"

install -d -m 700 "$LOCAL_CODEX_PROFILE_DIR"
env CODEX_HOME="$LOCAL_CODEX_PROFILE_DIR" \
  codex -c 'cli_auth_credentials_store="file"' login --device-auth

chmod 600 "$LOCAL_CODEX_PROFILE_DIR/auth.json"
```

Create an external stage-agent config. This example writes only file references;
it does not embed credential material.

```bash
AI_IMPLEMENT_PRIVATE_DIR="$HOME/.ai-implement-local-feedback"
AGENT_CONFIG="$AI_IMPLEMENT_PRIVATE_DIR/agent-config.json"
TARGET_REPO="$HOME/src/private-target-repo"
MODEL_NAME="<chosen-supported-model>"
LOCAL_CODEX_PROFILE_DIR="$HOME/.ai-implement-local-codex-profile"

install -d -m 700 "$AI_IMPLEMENT_PRIVATE_DIR"

# Must exactly match the target repository's GitHub origin owner/repo.
PROJECT_KEY="owner/private-target-repo"

export AGENT_CONFIG PROJECT_KEY MODEL_NAME LOCAL_CODEX_PROFILE_DIR

node <<'NODE'
const fs = require("node:fs");
const configPath = process.env.AGENT_CONFIG;
const projectKey = process.env.PROJECT_KEY;
const model = process.env.MODEL_NAME;
const sessionPath = `${process.env.LOCAL_CODEX_PROFILE_DIR}/auth.json`;
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
    sessionSource: "local-login",
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

Use a clean target checkout. If a cancelled or failed run leaves a session lock
held for the same `auth.json`, inspect the artifact directory before trying
again. A partial artifact set should still show the source proof, image proof,
selected stages, and the step where execution stopped.
