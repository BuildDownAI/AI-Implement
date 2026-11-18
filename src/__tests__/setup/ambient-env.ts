// A test sees the environment its allowlist describes, never the machine's.
// What a runner, a Fly machine, the dev harness or GitHub Actions sets cannot change what a test exercises.
// Every variable the allowlist does not cover is deleted before the test file is imported.
// Deleted, not stubbed: vi.unstubAllEnvs() would restore a stubbed value.
// A test that needs a variable sets it itself, at its top level or in a beforeEach.
// Names match in any case on every OS, because Windows names variables case-insensitively and lists PATH as Path.
// Reference: docs/unit-tests.md § Isolation from the machine.

export interface EnvAllowlist {
  /** Variable name → why its value must survive the scrub. */
  readonly names: Readonly<Record<string, string>>;
  /** Name prefix → why every variable starting with it must survive the scrub. */
  readonly prefixes: Readonly<Record<string, string>>;
  /** Variable → the value every test sees whatever the machine set, and why. */
  readonly pinned: Readonly<Record<string, { readonly value: string; readonly reason: string }>>;
  /** Variable → why it is set to the test run's own temp directory (run-temp-root.ts). */
  readonly tempRoot: Readonly<Record<string, string>>;
}

export const BASE_ENV_ALLOWLIST: EnvAllowlist = {
  names: {
    PATH: "Tests spawn git, bash and other binaries by name, and cannot start them without it.",
    DEDUP_DB_PATH:
      "Both vitest configs set it to :memory: through test.env. " +
      "Without it, dedup.ts opens /data/dedup.sqlite or /tmp/ai-implement.sqlite, a real database every test file shares.",
    CODEX_PINNED_PROOF:
      "An operator switch, not machine state. " +
      "`required` turns codex-planning-adapter.test.ts's pinned-CLI tests from a skip into a failure when codex 0.159.2 is missing (docs/pipeline-architecture.md). " +
      "Deleted, the gated run skips silently.",
    CAPTURE_FIXTURES:
      "An operator switch, not machine state. " +
      "Set, planning-launch.test.ts rewrites fixtures/planning-opted-out.json instead of comparing against it. " +
      "Deleted, a regeneration run only compares.",
    UPDATE_CONTRACT_FIXTURES:
      "An operator switch, not machine state. " +
      "Set to 1, job-accounting-contract.test.ts rewrites docs/contracts/list_job_accounting instead of comparing against it. " +
      "Deleted, a regeneration run only compares.",
    UPDATE_JOURNAL_SNAPSHOTS:
      "An operator switch, not machine state. " +
      "Set to 1, implementation-run-journal.restate.test.ts rewrites its journal snapshots instead of comparing against them. " +
      "Deleted, a regeneration run only compares.",
  },
  prefixes: {},
  pinned: {
    NODE_ENV: {
      value: "test",
      reason:
        "retry-backoff.ts skips its sleeps only when NODE_ENV is test. " +
        "Without the pin, the push-retry tests wait out real backoff and time out.",
    },
    TZ: {
      value: "UTC",
      reason:
        "Preventive: no test depended on the time zone when this pin was added. " +
        "It keeps a future date-handling test from following the machine's zone.",
    },
    GIT_CONFIG_GLOBAL: {
      value: "/dev/null",
      reason:
        "A developer's ~/.gitconfig reaches every git call a test makes, and settings such as commit.gpgsign fail its commits. " +
        "It also turns the real `git config --global` writes some tests reach into harmless failures, instead of replacing the developer's credential helper.",
    },
    GIT_CONFIG_NOSYSTEM: {
      value: "1",
      reason: "The machine's system gitconfig reaches git the same way, and deleting variables cannot stop git reading it.",
    },
  },
  tempRoot: {
    TMPDIR:
      "os.tmpdir() reads it first on Linux and macOS. " +
      "The tsx and restate-server children some tests start also put their temp files under it.",
    TMP: "os.tmpdir() reads it second on Linux and macOS, and second on Windows after TEMP.",
    TEMP:
      "os.tmpdir() reads it first on Windows. " +
      "Deleted with TMP, it falls back to SystemRoot, which is deleted too, and returns the relative path undefined\\temp, so every testDir and mkdtemp call fails.",
  },
};

export function isAllowedEnvName(allowlist: EnvAllowlist, name: string): boolean {
  const upper = name.toUpperCase();
  const listed = [allowlist.names, allowlist.pinned, allowlist.tempRoot].some((part) =>
    Object.keys(part).some((key) => key.toUpperCase() === upper),
  );
  return listed || Object.keys(allowlist.prefixes).some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

export function scrubAmbientEnv(allowlist: EnvAllowlist, tempRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if (!isAllowedEnvName(allowlist, name)) delete env[name];
  }
  for (const [name, { value }] of Object.entries(allowlist.pinned)) env[name] = value;
  for (const name of Object.keys(allowlist.tempRoot)) env[name] = tempRoot;
}
