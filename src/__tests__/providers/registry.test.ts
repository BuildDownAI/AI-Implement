import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRegistry } from "../../providers/registry.js";
import { configureLinearAuth } from "../../linear-app-auth.js";
import type { TicketingProvider } from "../../providers/types.js";
import { makeIssue, makeMapping, makeProvider, makeRegistry } from "../helpers/builders.js";

const linearMapping = makeMapping();
const jiraMapping = makeMapping({
  ticketingProvider: "jira",
  ticketingConfig: { kind: "jira", jql: "project = TEST", repoFieldValue: "acme/test" },
});

// Linear provider construction now requires the app credential to be configured.
beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("ProviderRegistry", () => {
  const filesystemMapping = makeMapping({
    ticketingProvider: "filesystem",
    ticketingConfig: { kind: "filesystem", directory: "/tmp/test-tickets" },
  });

  it("resolves and caches filesystem tickets locally without tracker credentials", async () => {
    vi.stubEnv("RUNNER_MODE", "local");
    const reg = new ProviderRegistry({}, () => ({ LOCAL: filesystemMapping }));
    const first = await reg.forMapping(filesystemMapping);
    expect(first.id).toBe("filesystem");
    expect(await reg.forMapping(filesystemMapping)).toBe(first);
    expect(await reg.forAllMappings([filesystemMapping, filesystemMapping])).toEqual([first]);
    reg.invalidate();
    expect(await reg.forMapping(filesystemMapping)).not.toBe(first);
  });

  it("refuses filesystem tickets outside local mode even after caching a provider", async () => {
    vi.stubEnv("RUNNER_MODE", "local");
    const reg = new ProviderRegistry({}, () => ({ LOCAL: filesystemMapping }));
    await reg.forMapping(filesystemMapping);
    vi.stubEnv("RUNNER_MODE", "gha");
    await expect(reg.forMapping(filesystemMapping)).rejects.toThrow(/local runner mode/);
  });

  it("returns a Linear provider for a Linear mapping", async () => {
    const reg = new ProviderRegistry({}, () => ({}));
    const p = await reg.forMapping(linearMapping);
    expect(p.id).toBe("linear");
  });

  it("returns a Jira provider for a Jira mapping", async () => {
    const reg = new ProviderRegistry(
      { jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://x" },
      () => ({}),
    );
    const p = await reg.forMapping(jiraMapping);
    expect(p.id).toBe("jira");
  });

  it("returns the same Linear provider instance across calls", async () => {
    const reg = new ProviderRegistry({}, () => ({}));
    const p1 = await reg.forMapping(linearMapping);
    const p2 = await reg.forMapping(linearMapping);
    expect(p1).toBe(p2);
  });

  it("forAllMappings returns one provider per unique id", async () => {
    const reg = new ProviderRegistry(
      { jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://x" },
      () => ({}),
    );
    const providers = await reg.forAllMappings([linearMapping, linearMapping, jiraMapping]);
    expect(providers).toHaveLength(2);
  });

  it("forAllMappings skips providers whose construction fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // No Jira env, so Jira construction will throw MissingProviderConfigError.
    const reg = new ProviderRegistry({}, () => ({}));
    const providers = await reg.forAllMappings([linearMapping, jiraMapping]);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("linear");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("jira"));
    warn.mockRestore();
  });

  it("invalidate() drops cached instances", async () => {
    const reg = new ProviderRegistry({}, () => ({}));
    const p1 = await reg.forMapping(linearMapping);
    reg.invalidate();
    const p2 = await reg.forMapping(linearMapping);
    expect(p1).not.toBe(p2);
  });
});

describe("ProviderRegistry.findByKeyInAnyTracker", () => {
  const issue = makeIssue({ id: "i1", identifier: "KEY-1" });
  function stub(id: string, behavior: "issue" | "null" | "throw") {
    return makeProvider({
      id,
      findByKey: vi.fn(async () => {
        if (behavior === "throw") throw new Error("boom");
        return behavior === "issue" ? issue : null;
      }),
    });
  }
  // One mapping per tracker, so the real forAllMappings picks each stub through its mapping.
  function setup(stubs: TicketingProvider[]) {
    return makeRegistry({
      providers: Object.fromEntries(stubs.map((s) => [s.id, s])),
      mappings: Object.fromEntries(stubs.map((s) => [s.id, makeMapping({ ticketingProvider: s.id })])),
    });
  }

  it("found: exactly one issue, none throw", async () => {
    const r = await setup([stub("linear", "null"), stub("jira", "issue")]).findByKeyInAnyTracker("KEY-1");
    expect(r).toMatchObject({ kind: "found", failedProviderIds: [] });
    expect((r as { provider: { id: string } }).provider.id).toBe("jira");
  });

  it("found with failures: one issue, one throws", async () => {
    const r = await setup([stub("linear", "throw"), stub("jira", "issue")]).findByKeyInAnyTracker("KEY-1");
    expect(r).toMatchObject({ kind: "found", failedProviderIds: ["linear"] });
  });

  it("ambiguous: queries every provider and sorts ids", async () => {
    const stubs = [stub("linear", "issue"), stub("jira", "issue"), stub("filesystem", "throw")];
    const r = await setup(stubs).findByKeyInAnyTracker("KEY-1");
    expect(r).toEqual({ kind: "ambiguous", providerIds: ["jira", "linear"] });
    for (const s of stubs) expect(s.findByKey).toHaveBeenCalledWith("KEY-1");
  });

  it("none: all return null", async () => {
    const r = await setup([stub("linear", "null"), stub("jira", "null")]).findByKeyInAnyTracker("KEY-1");
    expect(r).toEqual({ kind: "none", failedProviderIds: [] });
  });

  it("none: mix of null and throws lists failed ids sorted", async () => {
    const r = await setup([stub("linear", "throw"), stub("jira", "null"), stub("filesystem", "throw")]).findByKeyInAnyTracker("KEY-1");
    expect(r).toEqual({ kind: "none", failedProviderIds: ["filesystem", "linear"] });
  });
});

