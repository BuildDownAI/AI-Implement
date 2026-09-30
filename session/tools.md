# Power tools available in this environment

Beyond the usual POSIX toolbox, this runner ships with:

- `rg` (ripgrep) — fast regex search across files. Prefer over `grep -r`.
- `fd` — fast file finder. Prefer over `find` for simple name/type searches.
- `sg` (ast-grep) — structural (AST) search and rewrite. Use for refactors that
  regex would botch (e.g. renaming a method only in call sites, not strings).
- `yq` — YAML query/mutate (Mike Farah's Go build, not the Python one). jq-like syntax.
- `jq` — JSON query/mutate.
- `tree` — directory tree view; `tree -L 2` for a quick overview.
- `sqlite3` — SQLite CLI.
- `shellcheck` — lint bash; use to self-verify shell scripts you write.
- `git-lfs` — installed and initialized; `git clone` transparently fetches LFS blobs.
- `gh` — GitHub CLI; authenticated for the current repo.
- `corepack` — enables `yarn` and `pnpm` on demand without extra installs.
- `@anthropic-ai/claude-code` — this is the `claude` CLI itself; don't re-invoke.

Standard runtimes present: Node.js 22, Python 3 (Bookworm), build-essential toolchain.
Language runtimes beyond Node/Python belong in a per-repo custom image — see
`.ai-implement/image.yml` in the target repo.
