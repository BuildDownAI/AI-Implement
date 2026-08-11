# Deploying the orchestrator

How an orchestrator instance gets deployed, how a new client instance is stood up, and how to point a target repo at AWS Bedrock.

Reference for `scripts/deploy-orchestrator.sh`, `scripts/provision-client.sh`, `clients/`, `.github/workflows/deploy-clients.yml`, and the Bedrock path in the synced workflows. `CLAUDE.md` carries the summary and points here.

## Deploy paths

Three ways an orchestrator gets deployed, in descending order of how often they are actually used.

### The wrapper script — the standard command

```bash
./scripts/deploy-orchestrator.sh ai-implement-testing-orchestrator
./scripts/deploy-orchestrator.sh <other-app-name>
```

This is the correct command for any orchestrator carrying the KG sidecar, which is all of them. It encodes the build secret, `--no-cache`, and an exported `GH_TOKEN`, then asserts the deployed `/mcp` answers 401 before exiting.

**The app name is required** — the script exits 64 with a usage message when it is missing, rather than falling back to a default. That is deliberate: a default would let a fork deploy itself over the upstream app. **A plain `fly deploy` silently ships a sidecar-less image** — see [kg-sidecar.md](kg-sidecar.md) for why each flag is load-bearing.

### Fly's native GitHub integration

A Fly app can watch a branch and deploy on push, with no workflow involved. Fly documents little of this, so the behaviour worth knowing:

- **The attached app wins over `fly.toml`'s `app` key.** Deploys reach the attached app despite a different name in the root toml, and no stray app is created — so one repo can serve several apps without per-app toml edits.
- **Auto-deploy is off by default, and the toggle only appears *after* attaching the repo.** Every new connection must enable it explicitly, or pushes deploy nothing.
- **Attaching does not itself deploy.** The first deploy happens on the next push to the watched branch.
- **The release `USER` field shows the connecting account even for integration deploys**, so it cannot distinguish an automated deploy from a manual one. Correlate by timestamp instead.

Note the interaction with the sidecar: an integration deploy does not pass the KG build secret, so it produces a sidecar-less image unless the secret is configured in that build path.

### Manual fallback

```bash
flyctl deploy --remote-only --app <app-name>
```

Works from any logged-in checkout. Same sidecar caveat as above.

## Client instances

Each client is a separate Fly app described by a file in `clients/<slug>.toml`. Copy `clients/example-client.toml` to start, or use the guided helper:

```bash
./scripts/provision-client.sh <client-slug>
```

Manual equivalent:

```bash
cp clients/example-client.toml clients/<slug>.toml
# edit the file, then:
fly apps create <app_name> --org <org>
fly volumes create dedup_data --size 1 --region iad --app <app_name>
fly secrets set GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... --app <app_name>
```

The Fly volume `dedup_data` mounts at `/data` and holds the SQLite database. Only the GitHub App pair is required for the orchestrator to boot; ticketing credentials are needed for it to poll anything. See `.env.example` for the full set.

### The matrix workflow does not currently deploy clients

`.github/workflows/deploy-clients.yml` exists and triggers on pushes to `main`, building a deploy matrix by globbing `clients/*.toml`. **In practice it always deploys nothing**, because `.gitignore` excludes `clients/*.toml` and un-ignores only the example — which the workflow explicitly skips. Every run finds zero clients, emits an empty matrix, and skips the deploy job via its own guard, reporting success.

So a client toml is local-only unless force-added, and client instances are deployed through the wrapper script or the Fly integration rather than by this workflow. Treat the workflow as inert until that is deliberately resolved one way or the other.

### Per-instance Fly commands

```bash
fly secrets set KEY=value --app <app_name>   # set secrets
fly logs --app <app_name>                    # tail logs
fly ssh console --app <app_name>             # shell into the machine
```

## Using AWS Bedrock

To run a target repo against Bedrock instead of the Anthropic API, use the **GitHub Actions execution mode**. Bedrock is not supported on Fly Machines or local Docker: those backends have no equivalent of GitHub's OIDC role assumption, and the runner entrypoint rejects `provider=bedrock` outside GHA mode outright.

1. **In the admin UI (`/admin`)**, edit the repo's mapping: set **Provider** to `bedrock` and **AWS Region** to the region hosting your inference profile (e.g. `us-west-2`).
2. **In the target repo**, add a repository secret `AWS_BEDROCK_ROLE_ARN` — an IAM role trusting the GitHub OIDC provider for that repo, with `bedrock:InvokeModel` on the profiles you need.
3. **In the target repo**, add two repository *variables* so `/ai-implement` comment-triggered runs route to the same provider:
   - `AI_IMPLEMENT_PROVIDER` = `bedrock`
   - `AI_IMPLEMENT_AWS_REGION` = the same region
4. **In the target repo's `WORKFLOW.md`** (and `PLANNING.md` if planning is enabled), change `model:` to a Bedrock model ID or inference-profile ARN.

**Step 4 is not optional and nothing enforces it.** The workflows validate that `aws_region` and `AWS_BEDROCK_ROLE_ARN` are present, and fail clearly when they are not — but **nothing validates the model against the provider**. An Anthropic-style ID left in front matter is passed to Bedrock verbatim and fails at Claude invocation time with a provider error rather than a configuration error.

IAM trust policy shape, scoped to one repo:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:*" }
  }
}
```

Credentials are configured once before the containerized runner step with a **4-hour session duration**, covering the implementation and gap-analysis runs in a single job. Only GitHub OIDC is supported — there is no static-key path.
