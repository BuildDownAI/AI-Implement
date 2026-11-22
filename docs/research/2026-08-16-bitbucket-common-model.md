# Bitbucket as a compatibility test for the code-host common model

Date: 2026-08-16  
Status: research, before interface design

## Executive answer

Looking at Bitbucket before defining the common model is worthwhile. The proposed separation among `TicketProvider`, `CodeHostProvider`, and `ExecutionProvider` remains correct, and Bitbucket provides strong evidence for it. However, the neutral types should be adjusted before Milestone 1 so they do not encode GitHub/GitLab assumptions about repository identity, reviews, checks, merge readiness, workflow runners, or authentication.

The most important discovery is that **Bitbucket Cloud and Bitbucket Data Center should be treated as separate code-host adapters**. They share product vocabulary but have different REST surfaces, authentication and extension models, deployment topology, and CI/CD arrangements. Bitbucket Cloud provides Pipelines and hosted/self-hosted runners; Bitbucket Data Center's documented integrated CI/CD model connects external Bamboo or Jenkins installations. [Bitbucket Cloud Pipelines REST API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/) [Bitbucket Cloud runners](https://support.atlassian.com/bitbucket-cloud/docs/runners/) [Bitbucket Data Center CI integration](https://confluence.atlassian.com/bitbucketserver/link-your-ci-server-1032257995.html)

This does not require a fourth top-level interface. It does require deeper, outcome-oriented interfaces and provider capability discovery.

## Cloud and Data Center are different adapters

| Concern | Bitbucket Cloud | Bitbucket Data Center | Common-model implication |
| --- | --- | --- | --- |
| Deployment identity | Atlassian-hosted workspaces and repository UUIDs | Customer-controlled instance, projects, repositories, and version | Provider-scoped connection plus immutable repository ID |
| Pull requests | Cloud REST v2 | Instance REST resources with version-specific behavior | Separate adapters; neutral change-request model |
| CI execution | Bitbucket Pipelines and runners | External Bamboo/Jenkins or another CI server | Execution must remain independent from code host |
| Build feedback | Commit statuses and Code Insights reports/annotations | Builds and deployments REST resources | Normalize evidence/checks, not GitHub check runs |
| Authentication | OAuth, Forge/API tokens, repository/project/workspace access tokens | Instance HTTP access tokens and other instance auth | Opaque credential references and adapter-owned refresh/scopes |
| Issues | Optional repository issue tracker; unavailable in some centrally administered workspaces | Commonly Jira integration rather than a native equivalent | Ticket provider must remain independent |

Bitbucket Cloud's issue tracker is deliberately simple and is not supported in workspaces administered through `admin.atlassian.com`, making it unsuitable as an assumed companion to the Bitbucket code-host adapter. [Bitbucket Cloud issue tracker API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-issue-tracker/) [Issue tracker availability](https://support.atlassian.com/bitbucket-cloud/docs/use-the-issue-tracker/) Bitbucket Data Center documents Jira integration separately. [Bitbucket Data Center documentation](https://confluence.atlassian.com/bitbucketserver)

## Adjustments required before Milestone 1

### 1. Make repository identity provider-scoped and immutable

Do not use GitHub `owner/repo`, GitLab path, or Bitbucket workspace/slug as the durable identity. Paths and slugs can be presentation and routing values. The common identity should include:

```ts
interface RepositoryRef {
  connectionId: string;   // installed tenant or self-managed instance
  provider: CodeHostKind;
  id: string;             // opaque immutable provider identifier
  displayPath: string;
  webUrl?: string;
}
```

`CodeHostKind` should distinguish at least `github`, `gitlab`, `bitbucket-cloud`, and `bitbucket-data-center`. A self-managed instance belongs in `connectionId`, not in a proliferation of provider IDs.

Bitbucket Cloud returns repository UUIDs in its resource model. [Bitbucket Cloud repositories API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/)

### 2. Model both sides of a change request as repository plus ref

A pull request can originate from a fork, so `headBranch` and `baseBranch` are insufficient. Each side needs its own repository:

```ts
interface RevisionRef {
  repository: RepositoryRef;
  ref: string;
  sha?: string;
}

interface ChangeRequestRef {
  repository: RepositoryRef; // repository that owns the change request
  id: string;                // opaque stable provider ID
  displayNumber?: number;
  url: string;
  source: RevisionRef;
  target: RevisionRef;
}
```

Bitbucket pull-request representations explicitly contain source and destination repository/ref information; Bitbucket Data Center represents these as `fromRef` and `toRef`. [Bitbucket Cloud pull requests API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/) [Bitbucket Data Center pull requests API](https://developer.atlassian.com/server/bitbucket/rest/v1000/api-group-pull-requests/)

This is also the correct model for GitHub and GitLab fork-based change requests.

### 3. Separate review decisions from actionable blockers

Do not flatten review state to `approved: boolean` or assume that all requested work appears as a GitHub review thread. Bitbucket Cloud exposes approvals, requested changes, comments, resolvable comments, and pull-request tasks. Bitbucket merge checks can independently require approvals, no requested changes, resolved tasks, successful builds, or an adequately up-to-date destination branch. [Bitbucket Cloud pull requests API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/) [Bitbucket Cloud merge checks](https://support.atlassian.com/bitbucket-cloud/docs/suggest-or-require-checks-before-a-merge/)

The neutral model should distinguish:

```ts
type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "commented"
  | "unreviewed";

interface ReviewBlocker {
  id: string;
  kind: "task" | "thread" | "policy" | "check" | "conflict" | "behind" | "other";
  summary: string;
  resolved: boolean;
  url?: string;
}
```

Provider adapters should translate native review participants, tasks, blocker comments, and discussions into these product concepts. Bitbucket Data Center exposes participants/review status and blocker comments as distinct resources. [Bitbucket Data Center pull requests API](https://developer.atlassian.com/server/bitbucket/rest/v1000/api-group-pull-requests/)

### 4. Ask the provider for merge readiness

The orchestrator should not reconstruct mergeability by combining host-specific reviews and check runs. Bitbucket has built-in and custom merge checks, and custom checks may execute before or during the merge attempt. [Bitbucket Cloud custom merge checks](https://support.atlassian.com/bitbucket-cloud/docs/set-up-and-use-custom-merge-checks/)

Use an outcome-oriented operation:

```ts
interface MergeReadiness {
  state: "ready" | "blocked" | "unknown";
  headSha: string;
  blockers: ReviewBlocker[];
}

getMergeReadiness(change: ChangeRequestRef): Promise<MergeReadiness>;
```

The `headSha` binds the result to the revision that was evaluated.

### 5. Express merge intent instead of one universal merge operation

GitHub auto-merge, GitLab merge-when-pipeline-succeeds, Bitbucket automatic merge, and Bitbucket merge queues are related but not identical. Bitbucket Cloud also allows repository-configured merge strategies. [Bitbucket Cloud merge behavior](https://support.atlassian.com/bitbucket-cloud/docs/merge-a-pull-request/) [Bitbucket Cloud merge queues](https://support.atlassian.com/bitbucket-cloud/docs/manage-pull-requests-with-merge-queues/)

Prefer:

```ts
interface MergeIntent {
  timing: "now" | "when_ready" | "queue";
  strategy?: string;      // provider-advertised opaque ID
  expectedHeadSha: string;
  deleteSourceRef?: boolean;
}

type MergeResult =
  | { state: "merged"; mergeSha?: string }
  | { state: "queued"; queueRef?: string }
  | { state: "blocked"; blockers: ReviewBlocker[] };
```

Merge strategies should not be a closed GitHub-derived enum. The adapter should advertise supported strategies and defaults.

### 6. Normalize commit evidence rather than workflow/check-run objects

Bitbucket Cloud exposes commit statuses plus richer Code Insights reports and annotations. Bitbucket Data Center accepts build results for commits and surfaces them on related pull requests. [Bitbucket Cloud commit statuses](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/) [Bitbucket Cloud Code Insights reports](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-reports/) [Bitbucket Data Center build status](https://developer.atlassian.com/server/bitbucket/how-tos/updating-build-status-for-commits/)

The code-host interface should return normalized commit evidence:

```ts
interface CommitEvidence {
  id: string;
  category: "build" | "test" | "quality" | "security" | "review" | "other";
  state: "pending" | "passed" | "failed" | "cancelled" | "unknown";
  required?: boolean;
  summary: string;
  url?: string;
}
```

This evidence feeds `getMergeReadiness`; it is not itself the final merge decision.

### 7. Keep execution provider-neutral and capability-driven

`ExecutionProvider` should not require a workflow file, numeric run ID, or a code-host-native runner. A neutral interface needs an opaque definition reference and run reference:

```ts
interface ExecutionDefinitionRef {
  provider: string;
  id: string;
}

interface ExecutionRunRef {
  provider: string;
  id: string;
  url?: string;
}
```

Operations should cover dispatch and status, with cancellation, retry, logs, and native variables/inputs exposed through capabilities. Bitbucket Cloud supports pipeline creation, status, steps, logs, stopping, variables, and runners through its Pipelines REST resources. [Bitbucket Cloud Pipelines REST API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/) Bitbucket Data Center instead integrates external CI systems such as Bamboo and Jenkins, confirming that execution cannot be inferred from the repository host. [Bitbucket Data Center CI integration](https://confluence.atlassian.com/bitbucketserver/configure-your-ci-server-1721011916.html)

### 8. Make Git transport credentials opaque

`RepositoryLease` should not contain `githubToken`, assume bearer authentication, or embed a tokenized URL. It should carry an ephemeral Git transport description that the runner knows how to install without understanding the code host:

```ts
type GitCredential =
  | { kind: "http-basic"; username: string; password: SecretValue }
  | { kind: "http-bearer"; token: SecretValue }
  | { kind: "ssh"; privateKey: SecretValue; knownHosts?: string };

interface RepositoryLease {
  source: RevisionRef;
  target: RevisionRef;
  cloneUrl: string;
  credential: GitCredential;
  expectedSourceSha?: string;
  expiresAt?: string;
}
```

Bitbucket Cloud supports OAuth and repository/project/workspace access tokens; Bitbucket Data Center exposes instance-managed HTTP access tokens. [Bitbucket Cloud authentication](https://developer.atlassian.com/cloud/bitbucket/rest/intro/) [Bitbucket Data Center authentication API](https://developer.atlassian.com/server/bitbucket/rest/v1000/api-group-authentication/)

The durable configuration should store a credential reference, never the material passed to the runner.

### 9. Normalize webhooks after provider verification

Webhook signature/credential verification, event names, delivery identifiers, payload shapes, and subscription scope belong inside each adapter. The internal event should carry provider, connection, repository, event type, resource identity, occurred time when available, and an idempotency key. If a host does not provide a stable delivery ID, the adapter may derive a body hash plus subscription/event metadata.

Bitbucket Cloud provides repository/workspace webhook resources and enumerated event types; Bitbucket Data Center provides instance REST resources for repository/project webhooks. [Bitbucket Cloud webhooks](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-webhooks/) [Bitbucket Data Center repository webhooks](https://developer.atlassian.com/server/bitbucket/rest/v1000/api-group-repository/)

### 10. Add capability discovery without making the interface shallow

Capabilities vary by product, plan, instance version, repository configuration, and installed CI/check integrations. A single capability snapshot per connection/repository should tell orchestration and onboarding what is available:

```ts
interface CodeHostCapabilities {
  draftChangeRequests: boolean;
  reviewDecisions: ReviewDecision[];
  reviewTasks: boolean;
  inlineComments: boolean;
  automaticMerge: boolean;
  mergeQueue: boolean;
  mergeStrategies: string[];
  commitEvidence: boolean;
}
```

Capability discovery should prevent callers from probing with provider-specific exceptions, but it should not expose every native endpoint as another method. The provider remains a deep module whose interface describes product outcomes.

## Runner implications

The runner/orchestrator split proposed during the GitLab review still holds:

- runner: local clone/fetch/checkout, diff, stage, sensitive-file checks, commit, local review/fix loop, and concurrency-safe push;
- orchestrator: credentials, change-request creation, reviews/tasks/comments, merge readiness, merge intent, checks/evidence, webhook reconciliation, and cross-run branch coordination.

For cross-repository pull requests, the runner may clone the source or destination repository depending on whether it is creating a new branch or updating an existing fork branch. The `RepositoryLease` must therefore specify source and target explicitly rather than assuming one remote.

The runner should publish:

```ts
interface BranchPublication {
  source: RevisionRef;
  target: RevisionRef;
  expectedPreviousSourceSha?: string;
  newSourceSha: string;
  title: string;
  description: string;
  draft: boolean;
  reviewSummary?: ReviewSummary;
}
```

The orchestrator then calls an outcome-oriented `ensureChangeRequest(publication)` operation on the selected code-host adapter.

## Effect on the proposed milestones

### Milestone 1: define the interfaces

Add two non-production contract scenarios before finalizing the interfaces:

1. **Bitbucket Cloud fork scenario:** source and target are different repositories; review has requested changes plus an unresolved task; automatic merge is requested after builds pass.
2. **Bitbucket Data Center external-CI scenario:** repository host and execution provider are different connections; build evidence is attached to a commit; the merge operation requires optimistic, head-SHA-safe behavior.

If the neutral model can express these scenarios without provider-shaped escape hatches, it is likely deep enough for GitHub and GitLab as well.

### Milestone 2: migrate GitHub with parity

The completion criteria should include:

- no GitHub owner/repository/token fields in the runner interface;
- no direct `gh` or GitHub REST use in generic runner steps;
- source and target represented as `RevisionRef` even for same-repository changes;
- merge readiness supplied by the GitHub adapter;
- workflow runs represented as opaque `ExecutionRunRef`; and
- contract tests shared with the in-memory adapters.

### Milestone 3: implement GitLab

GitLab adapters should implement the same outcomes without adding GitLab-specific fields to the common interfaces. GitLab CI/CD inputs, merge-when-pipeline-succeeds, discussions, approvals, and self-managed connection details stay inside adapters and connection configuration.

### Subsequent Bitbucket milestone

Choose Bitbucket Cloud or Data Center deliberately; do not claim one implementation covers both. Bitbucket Cloud can pair with `BitbucketPipelinesExecutionProvider`. Data Center initially pairs more naturally with AI Implement's own execution path or a separately chosen Bamboo/Jenkins adapter.

## Recommendation

Keep the three-module architecture, but make the following changes before Milestone 1 is approved:

1. distinguish Bitbucket Cloud and Data Center adapters;
2. use provider-scoped immutable repository IDs;
3. put a repository on both the source and target revision;
4. separate review decisions, review blockers, commit evidence, and merge readiness;
5. express merge timing and strategy as a capability-backed intent;
6. keep execution references opaque and independent from the code host;
7. make Git transport credentials opaque and ephemeral;
8. normalize webhooks only after adapter-owned verification; and
9. prove the interface with the two Bitbucket-shaped contract scenarios before migrating GitHub.

These changes are modest compared with retrofitting them after GitHub and GitLab adapters exist. Bitbucket does not invalidate the proposed staging; it makes Milestone 1 materially better.
