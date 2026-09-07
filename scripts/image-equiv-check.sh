#!/usr/bin/env bash
# Usage: image-equiv-check.sh <tested-sha> <head-sha>
#
# Determines whether two commits produce an identical runner image by diffing
# them against the RUNNER_IMAGE_PATHS list below.
#
# Exit codes:
#   0  — image-equivalent (no image-relevant paths changed)
#   1  — not equivalent (at least one image-relevant path changed)
#   2  — error (bad arguments, unreachable SHA, git failure)
#
# CANONICAL PATH LIST
# This is the single source of truth for which repository paths affect the
# runner image.  .github/workflows/build-runner.yml on.push.paths MUST be
# kept in sync with this list; GHA does not support env-var interpolation in
# on: blocks, so the list is necessarily duplicated there.

set -euo pipefail

RUNNER_IMAGE_PATHS=(
  "Dockerfile.session"
  "session/**"
  "src/**"
  "pipelines/**"
  "custom/**"
  ".github/workflows/build-runner.yml"
)

if [ $# -ne 2 ]; then
  echo "Usage: $0 <tested-sha> <head-sha>" >&2
  exit 2
fi

tested_sha="$1"
head_sha="$2"

for sha in "$tested_sha" "$head_sha"; do
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::Invalid SHA format: ${sha}" >&2
    exit 2
  fi
done

if [ "$tested_sha" = "$head_sha" ]; then
  echo "Tested SHA and head SHA are identical — trivially equivalent" >&2
  exit 0
fi

# Ensure both commits are reachable locally; shallow-fetch from origin if not.
for sha in "$tested_sha" "$head_sha"; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    if ! git fetch --depth=1 origin "$sha" 2>/dev/null; then
      echo "::error::Could not fetch commit ${sha} from origin" >&2
      exit 2
    fi
    if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
      echo "::error::Commit ${sha} is not reachable after fetch" >&2
      exit 2
    fi
  fi
done

diff_output=""
if ! diff_output=$(git diff --name-only "$tested_sha" "$head_sha" -- "${RUNNER_IMAGE_PATHS[@]}"); then
  echo "::error::git diff failed between ${tested_sha} and ${head_sha}" >&2
  exit 2
fi

if [ -z "$diff_output" ]; then
  echo "No image-relevant changes between ${tested_sha} and ${head_sha}" >&2
  exit 0
else
  printf 'Image-relevant changes between %s and %s:\n%s\n' \
    "$tested_sha" "$head_sha" "$diff_output" >&2
  exit 1
fi
