// A test sees the environment its allowlist describes, never the machine's.
// What a runner, a Fly machine, the dev harness or GitHub Actions sets cannot change what a test exercises.
// Every variable the allowlist does not cover is deleted before the test file is imported.
// Deleted, not stubbed: vi.unstubAllEnvs() would restore a stubbed value.
// A test that needs a variable sets it itself, at its top level or in a beforeEach.
// Reference: docs/unit-tests.md § Isolation from the machine.

export interface EnvAllowlist {
  /** Variable name → why its value must survive the scrub. */
  readonly names: Readonly<Record<string, string>>;
  /** Name prefix → why every variable starting with it must survive the scrub. */
  readonly prefixes: Readonly<Record<string, string>>;
  /** Variable → the value every test sees whatever the machine set, and why. */
  readonly pinned: Readonly<Record<string, { readonly value: string; readonly reason: string }>>;
}

export const BASE_ENV_ALLOWLIST: EnvAllowlist = {
  names: {
    PATH: "Tests spawn git, bash and other binaries by name, and cannot start them without it.",
    DEDUP_DB_PATH:
      "Both vitest configs set it to :memory: through test.env. " +
      "Without it, dedup.ts opens /data/dedup.sqlite or /tmp/ai-implement.sqlite, a real database every test file shares.",
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
        "It also turns the real `git config --global` writes some tests reach into harmless failures, " +
        "instead of replacing the developer's credential helper.",
    },
    GIT_CONFIG_NOSYSTEM: {
      value: "1",
      reason: "The machine's system gitconfig reaches git the same way, and deleting variables cannot stop git reading it.",
    },
  },
};

export function isAllowedEnvName(allowlist: EnvAllowlist, name: string): boolean {
  return (
    name in allowlist.names ||
    name in allowlist.pinned ||
    Object.keys(allowlist.prefixes).some((prefix) => name.startsWith(prefix))
  );
}

export function scrubAmbientEnv(allowlist: EnvAllowlist, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if (!isAllowedEnvName(allowlist, name)) delete env[name];
  }
  for (const [name, { value }] of Object.entries(allowlist.pinned)) env[name] = value;
}
