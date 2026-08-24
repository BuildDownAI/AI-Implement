# AI-Implement Glossary

## Developer harness

The developer harness runs AI-Implement against a live, bind-mounted checkout for maintainer testing. It can change that checkout and never publishes its changes.

**Not to be confused with:** A local run, which uses an isolated copy and leaves the source checkout unchanged.

## Local run

A local run processes one Markdown task in an isolated copy of a clean local checkout. It returns local artifacts and does not require a tracker or GitHub App.

**Not to be confused with:** The developer harness or GitHub publication.

## Local artifact

A local artifact is a reviewable result from a local run, including the patch, changed-file list, test summary, run summary, and logs.

**Not to be confused with:** A GitHub branch or pull request.

## Task document

A task document is a Markdown file that states one product outcome, its acceptance criteria, and optional run limits. It contains no repository path, credential, publication setting, or queue dependency.

**Not to be confused with:** A generated implementation plan or a tracker issue.

## Demo run

A demo run is a local run against the bundled disposable repository and task. It lets a user inspect AI-Implement without mounting a repository from the host.

**Not to be confused with:** A local run against the user's own repository.

## Managed run

A managed run starts through the always-on orchestrator and reports its lifecycle through configured external services. It can publish a branch and pull request.

**Not to be confused with:** A local run, which needs no orchestrator, tracker, or GitHub identity.

## Selected repository

The selected repository is the host Git repository that the user mounts read-only at `/repo` and names with `--repo /repo`. AI-Implement prints its resolved Git root before the run starts.

**Not to be confused with:** The isolated working copy where the pipeline makes changes.

## Local run success

A local run succeeds only when the full plan, implement, test, review, and summary loop completes with approval. Starting or completing the Docker container is not enough.

**Not to be confused with:** A partial run, which preserves artifacts but returns a nonzero exit code.

## Trusted repository

A trusted repository is source code that the user permits Claude Code to inspect, change in an isolated copy, and execute with network access. AI-Implement removes the model credential from setup and test processes that it starts, but commands started by Claude Code may inherit that credential.

**Not to be confused with:** A sandbox for hostile code. The first local release does not provide that guarantee.
