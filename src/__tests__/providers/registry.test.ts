import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../../providers/registry.js";
import type { RepoMapping } from "../../config.js";

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "test",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    awsRegion: null,
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    ...overrides,
  };
}

const linearMapping = makeMapping({ ticketingProvider: "linear", ticketingConfig: { kind: "linear" } });
const jiraMapping = makeMapping({
  ticketingProvider: "jira",
  ticketingConfig: { kind: "jira", jql: "project = TEST", repoFieldValue: "acme/test" },
});

describe("ProviderRegistry", () => {
  it("returns a Linear provider for a Linear mapping", async () => {
    const reg = new ProviderRegistry({ linearApiKey: "k" }, () => ({}));
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
    const reg = new ProviderRegistry({ linearApiKey: "k" }, () => ({}));
    const p1 = await reg.forMapping(linearMapping);
    const p2 = await reg.forMapping(linearMapping);
    expect(p1).toBe(p2);
  });

  it("forAllMappings returns one provider per unique id", async () => {
    const reg = new ProviderRegistry(
      { linearApiKey: "k", jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://x" },
      () => ({}),
    );
    const providers = await reg.forAllMappings([linearMapping, linearMapping, jiraMapping]);
    expect(providers).toHaveLength(2);
  });

  it("forAllMappings skips providers whose construction fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // No Jira env, so Jira construction will throw MissingProviderConfigError.
    const reg = new ProviderRegistry({ linearApiKey: "k" }, () => ({}));
    const providers = await reg.forAllMappings([linearMapping, jiraMapping]);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("linear");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("jira"));
    warn.mockRestore();
  });

  it("invalidate() drops cached instances", async () => {
    const reg = new ProviderRegistry({ linearApiKey: "k" }, () => ({}));
    const p1 = await reg.forMapping(linearMapping);
    reg.invalidate();
    const p2 = await reg.forMapping(linearMapping);
    expect(p1).not.toBe(p2);
  });
});
