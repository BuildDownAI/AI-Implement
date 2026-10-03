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

export function extendEnvAllowlist(base: EnvAllowlist, extra: Partial<EnvAllowlist>): EnvAllowlist {
  return {
    names: { ...base.names, ...extra.names },
    prefixes: { ...base.prefixes, ...extra.prefixes },
    pinned: { ...base.pinned, ...extra.pinned },
  };
}

// The Restate tier must also find its infrastructure: which runtime to use, and where the Docker daemon is.
// Each of these locates the test's engine; none configures the code under test.
export const RESTATE_ENV_ALLOWLIST = extendEnvAllowlist(BASE_ENV_ALLOWLIST, {
  names: {
    RESTATE_TEST_RUNTIME:
      "CI forces the runtime with it. " +
      "Without it, restate/harness.ts picks the container runtime wherever a Docker socket is usable, " +
      "so the binary job would silently test the wrong runtime.",
    XDG_RUNTIME_DIR: "restate/harness.ts looks for a rootless Docker socket under it.",
    SSH_AUTH_SOCK: "The Docker client reaches an ssh:// DOCKER_HOST through the SSH agent.",
    RYUK_CONTAINER_IMAGE: "testcontainers reads its cleanup container's image override from it.",
    SSHD_CONTAINER_IMAGE: "testcontainers reads its SSH tunnel container's image override from it.",
  },
  prefixes: {
    DOCKER_: "The Docker client finds and authenticates to the daemon through DOCKER_HOST, DOCKER_TLS_VERIFY and the rest.",
    TESTCONTAINERS_: "testcontainers reads its own configuration from these.",
  },
});

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
