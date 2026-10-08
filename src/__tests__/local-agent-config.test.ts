import { open as fsOpen, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalAgentConfigError,
  LocalSessionOwnership,
  createLocalCredentialPort,
  loadLocalAgentConfig,
  type LocalAgentConfigDiagnostic,
  type LocalAgentConfigFailure,
  type TerminationProof,
} from "../local/agent-config.js";

const API_SECRET = "sk-synthetic-api-key-0000";
const SESSION_SECRET = '{"synthetic":"session-0000"}';
const PROJECT = "local-proj";

let root: string;
let repo: string;
let outside: string;
const LOCK = ".session.json.ai-lock";
let diagnostics: LocalAgentConfigDiagnostic[];

async function privateFile(path: string, content: string): Promise<string> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function stageBlock(profile: string, agent = "codex", provider = "openai") {
  return { agent, provider, model: "m-1", accountProfileId: profile, invocationTimeoutMs: 60000 };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "configured",
    projectKey: PROJECT,
    stages: {
      planning: stageBlock("api-a"),
      implementation: stageBlock("sub-a"),
      review: stageBlock("api-b"),
    },
    profiles: [
      { id: "api-a", identity: "a", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key", credentialPath: join(outside, "a.key") },
      { id: "api-b", identity: "b", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key", credentialPath: join(outside, "b.key") },
      {
        id: "sub-a", identity: "s", revision: 2, agent: "codex", provider: "openai", authMode: "codex-subscription",
        sessionPath: join(outside, "session.json"), sessionSource: "local-login", trustedPrivateTesting: true,
      },
    ],
    ...overrides,
  };
}

async function writeConfig(cfg: unknown): Promise<string> {
  const path = join(outside, "agent-config.json");
  await writeFile(path, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return path;
}

function opts(configPath: string) {
  return {
    configPath,
    projectKey: PROJECT,
    forbiddenRoots: [repo],
    onDiagnostic: (d: LocalAgentConfigDiagnostic) => diagnostics.push(d),
  };
}

async function expectCategory(promise: Promise<unknown>, category: LocalAgentConfigFailure, forbidden: string[] = []) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LocalAgentConfigError);
  expect((error as LocalAgentConfigError).category).toBe(category);
  const text = `${(error as Error).message}${JSON.stringify(diagnostics)}`;
  for (const secret of [API_SECRET, SESSION_SECRET, ...forbidden]) expect(text).not.toContain(secret);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-config-"));
  await chmod(root, 0o700);
  repo = join(root, "repo");
  outside = join(root, "outside");
  await mkdir(repo);
  await mkdir(outside, { mode: 0o700 });
  await chmod(outside, 0o700);
  await privateFile(join(outside, "a.key"), `${API_SECRET}\n`);
  await privateFile(join(outside, "b.key"), "sk-synthetic-b");
  await privateFile(join(outside, "session.json"), SESSION_SECRET);
  diagnostics = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadLocalAgentConfig", () => {
  it("resolves all three stages without any control plane", async () => {
    const { resolution, references } = await loadLocalAgentConfig(opts(await writeConfig(baseConfig())));
    expect(resolution.mode).toBe("configured");
    if (resolution.mode !== "configured") return;
    expect(Object.keys(resolution.stages)).toEqual(["planning", "implementation", "review"]);
    expect(resolution.profiles.implementation.authMode).toBe("codex-subscription");
    expect([...references.keys()].sort()).toEqual(["api-a", "api-b", "sub-a"]);
  });

  it("applies explicit selections over file defaults", async () => {
    const cfg = baseConfig({ selections: { review: { accountProfileId: "api-a" } } });
    const { resolution } = await loadLocalAgentConfig(opts(await writeConfig(cfg)));
    if (resolution.mode !== "configured") throw new Error("expected configured");
    expect(resolution.stages.review.accountProfileId).toBe("api-a");
    expect(resolution.sources.review.accountProfileId).toBe("project");
  });

  it("returns legacy for legacy mode", async () => {
    const { resolution } = await loadLocalAgentConfig(opts(await writeConfig({ version: 1, mode: "legacy" })));
    expect(resolution).toEqual({ mode: "legacy" });
  });

  it("gives safe errors for missing, malformed and unsupported files", async () => {
    await expectCategory(loadLocalAgentConfig(opts(join(outside, "missing.json"))), "config_unreadable");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(`{ not json ${API_SECRET}`))), "config_malformed");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig({ ...baseConfig(), version: 2 }))), "config_unsupported");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig({ ...baseConfig(), extra: 1 }))), "config_invalid");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig({ ...baseConfig(), projectKey: "other" }))), "config_invalid");
  });

  it("rejects embedded raw keys and session data without echoing them", async () => {
    const cfg = baseConfig();
    (cfg.profiles[0] as Record<string, unknown>).apiKey = API_SECRET;
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg))), "embedded_secret");
    const cfg2 = baseConfig();
    (cfg2.profiles[2] as Record<string, unknown>).sessionData = SESSION_SECRET;
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg2))), "embedded_secret");
    const cfg3 = baseConfig();
    (cfg3.profiles[0] as Record<string, unknown>).credentialPath = API_SECRET;
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg3))), "unsafe_path");
  });

  it("rejects config and credential paths inside the repository, including via symlinks", async () => {
    const inRepoConfig = join(repo, "agent-config.json");
    await writeFile(inRepoConfig, JSON.stringify(baseConfig()));
    await expectCategory(loadLocalAgentConfig(opts(inRepoConfig)), "unsafe_path");
    await symlink(inRepoConfig, join(outside, "link-config.json"));
    await expectCategory(loadLocalAgentConfig(opts(join(outside, "link-config.json"))), "unsafe_path");

    await privateFile(join(repo, "a.key"), API_SECRET);
    const cfg = baseConfig();
    (cfg.profiles[0] as Record<string, unknown>).credentialPath = join(repo, "a.key");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg))), "unsafe_path");

    await symlink(join(repo, "a.key"), join(outside, "leaf-link.key"));
    const cfg2 = baseConfig();
    (cfg2.profiles[0] as Record<string, unknown>).credentialPath = join(outside, "leaf-link.key");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg2))), "unsafe_path");

    await symlink(repo, join(outside, "dirlink"));
    const cfg3 = baseConfig();
    (cfg3.profiles[0] as Record<string, unknown>).credentialPath = join(outside, "dirlink", "a.key");
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(cfg3))), "unsafe_path");
  });

  it("rejects loose permissions on selected references", async () => {
    await chmod(join(outside, "a.key"), 0o644);
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(baseConfig()))), "unsafe_permissions");
  });

  it("rejects subscription profiles without authorization or claiming hosted copies", async () => {
    const noAuth = baseConfig();
    delete (noAuth.profiles[2] as Record<string, unknown>).trustedPrivateTesting;
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(noAuth))), "subscription_unauthorized");
    const hosted = baseConfig();
    (hosted.profiles[2] as Record<string, unknown>).sessionSource = "hosted-copy";
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(hosted))), "hosted_session_copy");
  });

  it("rejects invalid combinations and bedrock with no fallback", async () => {
    const mismatch = baseConfig({ stages: { ...baseConfig().stages, review: stageBlock("api-b", "claude", "anthropic") } });
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(mismatch))), "resolution_rejected");
    const bedrock = baseConfig();
    (bedrock.profiles[0] as Record<string, unknown>).authMode = "bedrock";
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(bedrock))), "config_invalid");
    const unknown = baseConfig({ stages: { ...baseConfig().stages, review: stageBlock("nope") } });
    await expectCategory(loadLocalAgentConfig(opts(await writeConfig(unknown))), "resolution_rejected");
  });

  it("does not open unselected references", async () => {
    await rm(join(outside, "b.key"));
    const cfg = baseConfig({ stages: { ...baseConfig().stages, review: stageBlock("api-a") } });
    const { references } = await loadLocalAgentConfig(opts(await writeConfig(cfg)));
    expect(references.has("api-b")).toBe(false);
  });
});

describe("ownership and port", () => {
  async function setup(extraOutsideAlias = false) {
    const loaded = await loadLocalAgentConfig(opts(await writeConfig(baseConfig())));
    const ownership = new LocalSessionOwnership({ forbiddenRoots: [repo], onDiagnostic: (d) => diagnostics.push(d) });
    const port = createLocalCredentialPort({
      references: loaded.references,
      forbiddenRoots: [repo],
      ownership,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    void extraOutsideAlias;
    return { loaded, ownership, port, sub: loaded.references.get("sub-a")! };
  }

  it("loads API keys without ownership and independent API profiles do not contend", async () => {
    const { port } = await setup();
    expect(await port.load({ profileId: "api-a", authMode: "openai-api-key" })).toEqual({ kind: "api-key", apiKey: API_SECRET });
    expect(await port.load({ profileId: "api-b", authMode: "openai-api-key" })).toEqual({ kind: "api-key", apiKey: "sk-synthetic-b" });
    expect(port.persistSession).toBeDefined();
    await expectCategory(port.load({ profileId: "api-a", authMode: "codex-subscription" }), "credential_unreadable");
  });

  it("omits persistSession for API-only configurations", async () => {
    const cfg = baseConfig({ stages: { planning: stageBlock("api-a"), implementation: stageBlock("api-a"), review: stageBlock("api-b") } });
    const loaded = await loadLocalAgentConfig(opts(await writeConfig(cfg)));
    expect(createLocalCredentialPort({ references: loaded.references, forbiddenRoots: [repo] }).persistSession).toBeUndefined();
  });

  it("requires ownership before loading a subscription session", async () => {
    const { port } = await setup();
    await expectCategory(port.load({ profileId: "sub-a", authMode: "codex-subscription" }), "session_not_owned");
  });

  it("releases an unused lease without persisting or reading the session", async () => {
    const { ownership, sub } = await setup();
    const lease = await ownership.acquire(sub);
    expect(lease.used).toBe(false);
    expect(lease.refreshed).toBe(false);

    await ownership.releaseUnused(lease, { confirmTermination: async () => "confirmed" });
    expect(lease.status).toBe("released");
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([]);
    expect(await readFile(join(outside, "session.json"), "utf8")).toBe(SESSION_SECRET);

    const next = await ownership.acquire(sub);
    expect(next.status).toBe("owned");
    expect(next.used).toBe(false);
  });

  it("blocks a subscription load that started before unused release closes the lease", async () => {
    const loaded = await loadLocalAgentConfig(opts(await writeConfig(baseConfig())));
    const ownership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    const entered = deferred();
    const continueLoad = deferred();
    const port = createLocalCredentialPort({
      references: loaded.references,
      forbiddenRoots: [repo],
      ownership,
      io: {
        afterVerifyOwner: async () => {
          entered.resolve();
          await continueLoad.promise;
        },
      },
    });
    const sub = loaded.references.get("sub-a")!;
    const lease = await ownership.acquire(sub);

    const load = port.load({ profileId: "sub-a", authMode: "codex-subscription" });
    await entered.promise;

    const proofRequested = deferred();
    const proof = deferred<TerminationProof>();
    const release = ownership.releaseUnused(lease, {
      confirmTermination: async () => {
        proofRequested.resolve();
        return proof.promise;
      },
    });
    await proofRequested.promise;

    expect(lease.status).toBe("owned");
    expect(lease.used).toBe(false);
    await expectCategory(port.load({ profileId: "sub-a", authMode: "codex-subscription" }), "session_not_owned");

    continueLoad.resolve();
    await expectCategory(load, "session_not_owned");
    expect(lease.used).toBe(false);

    proof.resolve("confirmed");
    await release;
    expect(lease.status).toBe("released");
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([]);
  });

  it("does not release unused ownership after session use, unknown proof, held state, or stale fencing", async () => {
    const { ownership, port, sub } = await setup();
    const used = await ownership.acquire(sub);
    await port.load({ profileId: "sub-a", authMode: "codex-subscription" });
    expect(used.used).toBe(true);
    await expectCategory(ownership.releaseUnused(used, { confirmTermination: async () => "confirmed" }), "persistence_missing");
    expect(used.status).toBe("owned");
    await expectCategory(ownership.release(used, { confirmTermination: async () => "confirmed" }), "persistence_missing");
    expect(used.status).toBe("held");
    await expectCategory(ownership.releaseUnused(used, { confirmTermination: async () => "confirmed" }), "stale_owner");

    await rm(join(outside, LOCK));
    const staleOwnership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    const stale = await staleOwnership.acquire(sub);
    await rm(join(outside, LOCK));
    await expectCategory(staleOwnership.releaseUnused(stale, { confirmTermination: async () => "confirmed" }), "stale_owner");

    const unknownOwnership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    const unknown = await unknownOwnership.acquire(sub);
    await expectCategory(unknownOwnership.releaseUnused(unknown, { confirmTermination: async () => "unknown" }), "termination_unconfirmed");
    expect(unknown.status).toBe("held");
    await expectCategory(unknownOwnership.releaseUnused(unknown, { confirmTermination: async () => "confirmed" }), "stale_owner");
  });

  it("allows exactly one concurrent owner, across aliases", async () => {
    const { ownership, sub } = await setup();
    await symlink(join(outside, "session.json"), join(outside, "alias.json"));
    const aliasRef = { ...sub, profileId: "alias-profile", canonicalPath: join(outside, "alias.json") };
    const results = await Promise.allSettled([ownership.acquire(sub), ownership.acquire(aliasRef), ownership.acquire(sub)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as LocalAgentConfigError).category).toBe("session_busy");
    }
    // A second instance (another process) is also refused.
    const other = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    await expectCategory(other.acquire(sub), "session_busy");
  });

  it("durably persists the exact refreshed payload with private mode and survives container removal", async () => {
    const { ownership, port, sub } = await setup();
    const lease = await ownership.acquire(sub);
    expect(await port.load({ profileId: "sub-a", authMode: "codex-subscription" })).toEqual({
      kind: "session", sessionData: SESSION_SECRET, stateSequence: 0,
    });
    const refreshed = '{"synthetic":"refreshed-1"}\n  ';
    await port.persistSession!({ profileId: "sub-a", sessionData: refreshed });
    expect(await readFile(join(outside, "session.json"), "utf8")).toBe(refreshed);
    expect((await stat(join(outside, "session.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(outside)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(lease.used).toBe(true);
    expect(lease.refreshed).toBe(true);

    await ownership.release(lease, { confirmTermination: async () => "confirmed" });
    expect(lease.status).toBe("released");
    // Next owner sees refreshed state.
    const next = await ownership.acquire(sub);
    expect((await port.load({ profileId: "sub-a", authMode: "codex-subscription" }))).toMatchObject({ sessionData: refreshed });
    expect(next.status).toBe("owned");
  });

  it("keeps the old content and the hold when persistence fails", async () => {
    const loaded = await loadLocalAgentConfig(opts(await writeConfig(baseConfig())));
    const ownership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    const port = createLocalCredentialPort({
      references: loaded.references,
      forbiddenRoots: [repo],
      ownership,
      onDiagnostic: (d) => diagnostics.push(d),
      io: { rename: async () => { throw new Error(`boom ${SESSION_SECRET}`); } },
    });
    const sub = loaded.references.get("sub-a")!;
    const lease = await ownership.acquire(sub);
    await expectCategory(port.persistSession!({ profileId: "sub-a", sessionData: "new-state" }), "persistence_failed");
    expect(await readFile(join(outside, "session.json"), "utf8")).toBe(SESSION_SECRET);
    expect((await readdir(outside)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "confirmed" }), "persistence_missing");
    expect(lease.status).toBe("held");
    await expectCategory(ownership.acquire(sub), "session_busy");
  });

  it("flushes the hold record to disk before renaming it over the lock", async () => {
    const { ownership, sub } = await setup();
    const lease = await ownership.acquire(sub);
    const probe = await fsOpen(join(outside, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const spy = vi.spyOn(proto, "sync");
    try {
      await expectCategory(ownership.release(lease, { confirmTermination: async () => "confirmed" }), "persistence_missing");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(await readFile(join(outside, LOCK), "utf8")).holdReason).toBe("persistence_missing");
    expect((await readdir(outside)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("holds ownership when termination is unknown, throws, or persistence is missing", async () => {
    const { ownership, port, sub } = await setup();
    const lease = await ownership.acquire(sub);
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "confirmed" }), "persistence_missing");
    await port.persistSession!({ profileId: "sub-a", sessionData: "state-2" });
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "unknown" }), "termination_unconfirmed");
    await expectCategory(
      ownership.release(lease, { confirmTermination: async () => { throw new Error("docker down"); } }),
      "termination_unconfirmed",
    );
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "exited" as never }), "termination_unconfirmed");
    expect(lease.status).toBe("held");
    expect(JSON.parse(await readFile(join(outside, LOCK), "utf8")).holdReason).toBe("termination_unconfirmed");
    await expectCategory(ownership.acquire(sub), "session_busy");
    // Retry with confirmation releases the same held lease.
    await ownership.release(lease, { confirmTermination: async () => "confirmed" });
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([]);
  });

  it("fences a stale owner whose lock was replaced or removed", async () => {
    const { ownership, port, sub } = await setup();
    const lease = await ownership.acquire(sub);
    await rm(join(outside, LOCK));
    await expectCategory(port.persistSession!({ profileId: "sub-a", sessionData: "x" }), "stale_owner");
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "confirmed" }), "stale_owner");
    expect(await readFile(join(outside, "session.json"), "utf8")).toBe(SESSION_SECRET);
  });

  it("uses one session-derived lock regardless of configuration, process or alias", async () => {
    const { ownership, sub } = await setup();
    await ownership.acquire(sub);
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([LOCK]);
    // Second configuration/instance (different io seam) sees the same authority.
    const other = new LocalSessionOwnership({ forbiddenRoots: [repo], io: { syncDir: async () => undefined } });
    await expectCategory(other.acquire(sub), "session_busy");
    // A caller-supplied lockDir is ignored and cannot create a second authority.
    const legacy = new LocalSessionOwnership({ lockDir: join(root, "other-locks"), forbiddenRoots: [repo] } as never);
    await expectCategory(legacy.acquire(sub), "session_busy");
    await expect(readdir(join(root, "other-locks"))).rejects.toThrow();
    // A symlinked alias resolves to the same canonical lock under another profile id.
    await symlink(join(outside, "session.json"), join(outside, "alias.json"));
    await expectCategory(other.acquire({ ...sub, profileId: "alias", canonicalPath: join(outside, "alias.json") }), "session_busy");
  });

  it("rejects sessions inside the repository or in a group-writable directory", async () => {
    const { sub } = await setup();
    await mkdir(join(repo, "s"));
    await privateFile(join(repo, "s", "session.json"), "x");
    await expectCategory(
      new LocalSessionOwnership({ forbiddenRoots: [repo] }).acquire({ ...sub, canonicalPath: join(repo, "s", "session.json") }),
      "unsafe_path",
    );
    await chmod(outside, 0o770);
    await expectCategory(new LocalSessionOwnership({ forbiddenRoots: [repo] }).acquire(sub), "unsafe_permissions");
  });

  it("fails closed when the directory sync after persistence fails, then recovers on retry", async () => {
    const loaded = await loadLocalAgentConfig(opts(await writeConfig(baseConfig())));
    const ownership = new LocalSessionOwnership({ forbiddenRoots: [repo] });
    let failSync = true;
    const port = createLocalCredentialPort({
      references: loaded.references,
      forbiddenRoots: [repo],
      ownership,
      onDiagnostic: (d) => diagnostics.push(d),
      io: { syncDir: async () => { if (failSync) throw new Error(`sync ${SESSION_SECRET}`); } },
    });
    const sub = loaded.references.get("sub-a")!;
    const lease = await ownership.acquire(sub);
    await expectCategory(port.persistSession!({ profileId: "sub-a", sessionData: "fresh-1" }), "persistence_failed");
    expect(lease.refreshed).toBe(false);
    await expectCategory(ownership.release(lease, { confirmTermination: async () => "confirmed" }), "persistence_missing");
    expect(lease.status).toBe("held");
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([LOCK]);
    await expectCategory(ownership.acquire(sub), "session_busy");

    failSync = false;
    await port.persistSession!({ profileId: "sub-a", sessionData: "fresh-2" });
    expect(await readFile(join(outside, "session.json"), "utf8")).toBe("fresh-2");
    expect((await stat(join(outside, "session.json"))).mode & 0o777).toBe(0o600);
    expect(lease.refreshed).toBe(true);
    await ownership.release(lease, { confirmTermination: async () => "confirmed" });
    expect(lease.status).toBe("released");
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([]);
  });

  it("keeps the lock as a hold when directory sync fails on acquisition", async () => {
    const { sub } = await setup();
    const failing = new LocalSessionOwnership({ forbiddenRoots: [repo], io: { syncDir: async () => { throw new Error("nope"); } } });
    await expectCategory(failing.acquire(sub), "ownership_failed");
    expect(failing.leaseFor("sub-a")?.status).toBe("held");
    expect((await readdir(outside)).filter((n) => n.endsWith(".ai-lock"))).toEqual([LOCK]);
    await expectCategory(new LocalSessionOwnership({ forbiddenRoots: [repo] }).acquire(sub), "session_busy");
  });
});
