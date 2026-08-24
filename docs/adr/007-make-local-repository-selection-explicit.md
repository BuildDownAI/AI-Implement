# 007. Make local repository selection explicit

**Status:** Accepted
**Date:** 2026-08-18

## Context

Docker cannot use a host path unless the user mounts that path into the container. Inferring a repository from the current directory would hide this boundary and make it harder to run AI-Implement against another repository.

The local release must make the selected repository obvious before any model work starts.

## Decision

The quickstart names the host repository path and mounts it at `/repo`. The local command also receives `--repo /repo`. The task document does not contain the repository path.

The documented command uses this shape:

```sh
REPO=/path/to/repository
TASK=/path/to/task.md

docker run --rm -it \
  -v "$REPO:/repo:ro" \
  -v "$TASK:/task.md:ro" \
  -v "$HOME/.ai-implement:/output" \
  ghcr.io/builddownai/ai-implement-runner:latest local run --repo /repo --task /task.md
```

The launcher resolves the Git root from `/repo`, validates it, and prints the selected repository before it starts the run. The launcher then creates an isolated working copy. It does not change the mounted checkout.

The repository also publishes a small convenience wrapper. It accepts host paths such as `--repo /path/to/repository` and `--task /path/to/task.md`, creates the required Docker mounts, and invokes the same container command. The wrapper is optional. It requires no installation and contains no pipeline logic.

## Alternatives considered

- **Infer the repository from the host current directory** — rejected because the container cannot see that directory without a mount, and the selected repository would be less obvious.
- **Put the repository path in the task document** — rejected because task intent should be portable across machines and repositories.
- **Clone from a GitHub URL** — rejected because the local release must work without GitHub credentials or a GitHub App.
- **Put local-run behavior in the wrapper** — rejected because direct Docker use and wrapper use must have the same tested behavior.

## Consequences

The direct Docker command makes the host-to-container boundary explicit and works with any local Git repository. The wrapper gives users a shorter command without creating a second execution path.

The project must test that the wrapper produces the documented Docker invocation.
