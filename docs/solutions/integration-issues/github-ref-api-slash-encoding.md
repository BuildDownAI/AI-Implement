---
title: "GitHub git-ref API 404s when the branch name is URL-encoded as one segment"
module: github-api-client
category: integration-issues
date: 2026-05-31
problem_type: integration_issue
component: service_object
severity: medium
root_cause: wrong_api
resolution_type: code_fix
symptoms:
  - "`GET /repos/{o}/{r}/git/ref/heads/{ref}` returns 404 for any branch whose name contains slashes (e.g. `ai-implement/feature/ool-78`)"
  - "A branch-existence helper always reports the branch missing, so the caller re-attempts creation on every poll cycle"
  - "Unit tests pass because they exercise the helper with a slashless branch name, masking the bug"
tags:
  - github-api
  - git-refs
  - url-encoding
  - encodeuricomponent
  - feature-branches
related_components:
  - github-actions-dispatch
  - feature-branch-grouping
---

# GitHub git-ref API 404s when the branch name is URL-encoded as one segment

## Problem

A helper that checks whether a branch exists via the GitHub git-refs API
(`GET /repos/{owner}/{repo}/git/ref/heads/{ref}`) built the URL with
`encodeURIComponent(branch)`. For multi-segment branch names like
`ai-implement/feature/ool-78`, that encodes the `/` separators into `%2F`, so
GitHub never matches the ref and returns 404.

## Symptoms

- `getBranchSha("ai-implement/feature/ool-78")` always returns `null` (404),
  even when the branch exists on the remote.
- `ensureBranchExists` therefore always falls through to the create path and
  fires a redundant `POST /git/refs` on every poll cycle. (The branch is still
  created the first time and subsequent 422s are tolerated as an "already
  exists" race, so the feature *appears* to work — the existence check is just
  silently dead.)
- The unit test for the "no-op when the branch already exists" path passed
  because it used the flat branch name `feat`, where `encodeURIComponent` is a
  no-op.

## What Didn't Work

- **Trusting the passing test suite.** The `ensureBranchExists` "already exists →
  no-op" test was green, but it used a slashless name. The bug only manifests for
  the real input shape (`ai-implement/feature/<key>`), which no test exercised.
  A multi-agent code review (maintainability + testing personas, cross-reviewer
  agreement) caught it by reading the actual call site's branch-name shape rather
  than the test's.

## Solution

Encode each path segment individually and re-join with literal slashes, so the
`/` separators in the ref path are preserved:

```ts
// Before — encodes the slashes into %2F, ref never matches, always 404:
const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`;

// After — encode each segment, keep the separators:
const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`;
```

The companion create call (`POST /git/refs` with a JSON body `{ ref:
"refs/heads/<branch>", sha }`) was already correct — the branch name there
travels in the request body, not the URL path, so it needs no encoding.

## Why This Works

`encodeURIComponent` is designed to encode a value that occupies a **single**
URI component, so it percent-encodes `/` (to `%2F`) on the assumption the slash
is data, not structure. But in the git-refs endpoint the ref *is* a multi-segment
path (`heads/ai-implement/feature/ool-78`) where the slashes are meaningful path
separators. Splitting on `/`, encoding each segment, and re-joining preserves the
path structure while still escaping any unsafe characters inside a segment.

## Prevention

- **Test API-path helpers with the real input shape.** When a helper builds a URL
  from a value that can contain slashes (branch/ref names, file paths, object
  keys), add a test asserting the constructed URL keeps the separators:

  ```ts
  await getBranchSha("t", "o", "r", "ai-implement/feature/ool-78");
  const url = vi.mocked(fetch).mock.calls[0][0] as string;
  expect(url).toBe("https://api.github.com/repos/o/r/git/ref/heads/ai-implement/feature/ool-78");
  expect(url).not.toContain("%2F");
  ```

- **Reach for `encodeURIComponent` only for single-segment values.** For a value
  that is itself a path, use `value.split("/").map(encodeURIComponent).join("/")`.
- **Pick test fixtures that match production inputs.** A slashless `feat` fixture
  hid this for a feature whose only real branch names are `ai-implement/feature/*`.
  Fixtures should resemble the actual values the code receives.
