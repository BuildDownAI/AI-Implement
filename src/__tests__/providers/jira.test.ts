import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraProvider, createJiraProviderFromConfig } from "../../providers/jira.js";
import { JiraClient } from "../../providers/jira-client.js";
import { MissingProviderConfigError, type TicketingProvider } from "../../providers/types.js";
import { clearFieldCache } from "../../providers/jira-fields.js";
import type { RepoMapping } from "../../config.js";

const stubClient = () => new JiraClient({ token: "t", cloudId: "c" });
const noMappings = () => ({});

describe("JiraProvider", () => {
  it("constructs with required dependencies", () => {
    const p = new JiraProvider({
      client: stubClient(),
      cacheScope: "cloud-id",
      siteUrl: "https://acme.atlassian.net",
      getMappings: noMappings,
    });
    expect(p.id).toBe("jira");
  });

  it("satisfies TicketingProvider at the type level", () => {
    const p = new JiraProvider({
      client: stubClient(),
      cacheScope: "c",
      siteUrl: "https://x",
      getMappings: noMappings,
    });
    const provider: TicketingProvider = p;
    expect(provider.id).toBe("jira");
  });

  it("issueUrl returns a /browse/<key> URL", () => {
    const p = new JiraProvider({
      client: stubClient(),
      cacheScope: "c",
      siteUrl: "https://acme.atlassian.net",
      getMappings: noMappings,
    });
    const issue = {
      id: "10001", identifier: "PROJ-123", title: "x", description: null,
      scopeKey: "mapping-1", nativeStatus: "Ready",
    };
    expect(p.issueUrl(issue)).toBe("https://acme.atlassian.net/browse/PROJ-123");
  });
});

describe("createJiraProviderFromConfig", () => {
  it("throws when jiraToken is missing", () => {
    expect(() => createJiraProviderFromConfig({ jiraCloudId: "c", jiraSiteUrl: "https://s" }, noMappings))
      .toThrow(MissingProviderConfigError);
  });

  it("throws when jiraCloudId is missing", () => {
    expect(() => createJiraProviderFromConfig({ jiraToken: "t", jiraSiteUrl: "https://s" }, noMappings))
      .toThrow(MissingProviderConfigError);
  });

  it("throws when jiraSiteUrl is missing", () => {
    expect(() => createJiraProviderFromConfig({ jiraToken: "t", jiraCloudId: "c" }, noMappings))
      .toThrow(MissingProviderConfigError);
  });

  it("constructs successfully with all three", () => {
    const p = createJiraProviderFromConfig(
      { jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://x" },
      noMappings,
    );
    expect(p.id).toBe("jira");
  });
});

describe("JiraProvider.postComment", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("posts a comment with ADF-formatted body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "comment-1" }),
    } as Response);

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c" }),
      cacheScope: "c", siteUrl: "https://x", getMappings: () => ({}),
    });
    await p.postComment("10001", "Hello world");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/rest\/api\/3\/issue\/10001\/comment$/),
      expect.objectContaining({
        method: "POST",
      }),
    );
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    expect(body.body.type).toBe("doc");
    expect(body.body.content[0].type).toBe("paragraph");
  });
});

// --- Lifecycle status setters ---

const baseMapping: Omit<RepoMapping, "ticketingProvider" | "ticketingConfig"> = {
  owner: "acme",
  repo: "x",
  workflowFile: "claude-implement.yml",
  defaultBranch: "main",
  maxInProgressAiIssues: 3,
  executionMode: "github-actions",
  sessionMode: "autonomous",
  machineCpus: 2,
  machineMemoryMb: 4096,
  planningEnabled: true,
  planningWorkflowFile: "claude-plan.yml",
  autoApprovePlans: true,
  extraEnv: {},
  provider: "anthropic",
  awsRegion: null,
  paused: false,
};

const jiraMapping = (
  overrides: Partial<{
    jql: string;
    repoFieldValue: string;
    statusFieldOverride: string | null;
    repoFieldOverride: string | null;
  }> = {},
): RepoMapping => ({
  ...baseMapping,
  ticketingProvider: "jira",
  ticketingConfig: {
    kind: "jira",
    jql: overrides.jql ?? "project = TEST",
    repoFieldValue: overrides.repoFieldValue ?? "acme/x",
    statusFieldOverride: overrides.statusFieldOverride,
    repoFieldOverride: overrides.repoFieldOverride,
  },
});

const FIELDS_RESPONSE = {
  ok: true,
  json: async () => [
    { id: "customfield_10100", name: "AI-Implement Status", custom: true, schema: {} },
    { id: "customfield_10101", name: "AI-Implement Repo", custom: true, schema: {} },
  ],
} as Response;

const okEmpty = () => ({ ok: true, json: async () => ({}) }) as Response;

function makeProvider(opts: {
  cacheScope: string;
  mappings: Record<string, RepoMapping>;
}): JiraProvider {
  return new JiraProvider({
    client: new JiraClient({ token: "t", cloudId: "c" }),
    cacheScope: opts.cacheScope,
    siteUrl: "https://x",
    getMappings: () => opts.mappings,
  });
}

describe("JiraProvider lifecycle status setters", () => {
  beforeEach(() => {
    clearFieldCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectStatusBody(call: [string | URL | Request, RequestInit | undefined], expected: string) {
    const body = JSON.parse(call[1]?.body as string);
    expect(body.fields.customfield_10100).toEqual({ value: expected });
  }

  it("markPlanningStarted sets status to Planning", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({ cacheScope: "c1", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanningStarted("10001", "acme/x");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Planning");
  });

  it("markPlanComplete sets status to Plan Approved (single-mapping shortcut)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({ cacheScope: "c2", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanComplete("10001");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Plan Approved");
  });

  it("markPlanningFailed sets Planning Failed and posts a comment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty()) // setField PUT
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "c1" }) } as Response); // comment POST
    const p = makeProvider({ cacheScope: "c3", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanningFailed("10001", "boom");

    const calls = vi.mocked(fetch).mock.calls;
    expectStatusBody(calls[1], "Planning Failed");
    const commentCall = calls[2];
    expect(commentCall[0]).toEqual(expect.stringMatching(/\/comment$/));
    const commentBody = JSON.parse(commentCall[1]?.body as string);
    expect(commentBody.body.content[0].content[0].text).toContain("boom");
  });

  it("markImplementing sets status to Implementing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({ cacheScope: "c4", mappings: { "acme/x": jiraMapping() } });
    await p.markImplementing("10001", "acme/x");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Implementing");
  });

  it("markPrReady sets PR Ready and posts a comment with the PR URL", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "c1" }) } as Response);
    const p = makeProvider({ cacheScope: "c5", mappings: { "acme/x": jiraMapping() } });
    await p.markPrReady("10001", "https://github.com/acme/x/pull/42");

    const calls = vi.mocked(fetch).mock.calls;
    expectStatusBody(calls[1], "PR Ready");
    const commentBody = JSON.parse(calls[2][1]?.body as string);
    expect(commentBody.body.content[0].content[0].text).toContain(
      "https://github.com/acme/x/pull/42",
    );
  });

  it("markImplementationFailed sets Implementation Failed and posts a comment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "c1" }) } as Response);
    const p = makeProvider({ cacheScope: "c6", mappings: { "acme/x": jiraMapping() } });
    await p.markImplementationFailed("10001", "kaboom");

    const calls = vi.mocked(fetch).mock.calls;
    expectStatusBody(calls[1], "Implementation Failed");
    const commentBody = JSON.parse(calls[2][1]?.body as string);
    expect(commentBody.body.content[0].content[0].text).toContain("kaboom");
  });

  it("clearWorkingState resets status to Plan Approved", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({ cacheScope: "c7", mappings: { "acme/x": jiraMapping() } });
    await p.clearWorkingState("10001");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Plan Approved");
  });

  it("multi-mapping markPlanComplete looks up scopeKey from the issue's repo field", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE) // listFields (first .fields() call)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: { customfield_10101: { value: "acme/y" } },
        }),
      } as Response) // getIssue
      .mockResolvedValueOnce(okEmpty()); // setField
    const p = makeProvider({
      cacheScope: "c8",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await p.markPlanComplete("10001");
    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    // The PUT URL should include /issue/10001
    expect(String(lastCall[0])).toMatch(/\/issue\/10001/);
    expectStatusBody(lastCall, "Plan Approved");
  });

  it("scopeKeyForIssue throws when no mapping matches the issue's repo field", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE) // listFields
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: { customfield_10101: { value: "acme/unknown" } },
        }),
      } as Response); // getIssue
    const p = makeProvider({
      cacheScope: "c-no-match",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await expect(p.markPlanComplete("10001")).rejects.toThrow(
      /No Jira mapping matched/,
    );
  });
});

describe("JiraProvider.fetchAIImplementSnapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    clearFieldCache();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const issue = (
    id: string, key: string, status: string, repo: string,
    desc: unknown = null, summary = `summary-${key}`,
  ) => ({
    id, key,
    fields: {
      summary, description: desc,
      customfield_10100: { value: status },
      customfield_10101: { value: repo },
    },
  });

  const searchOk = (issues: unknown[]): Response =>
    ({ ok: true, json: async () => ({ issues }) }) as Response;

  it("buckets issues by status field value", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        issue("10001", "P-1", "Ready", "acme/x"),
        issue("10002", "P-2", "Plan Approved", "acme/x", "desc"),
      ]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-snap-bucket" }),
      cacheScope: "c-snap-bucket", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-1"]);
    expect(snap.readyForImplementation.map((i) => i.identifier)).toEqual(["P-2"]);
    expect(snap.inProgressCountsByScope).toEqual({ "acme/x": 0 });
    expect(snap.readyForImplementation[0].description).toBe("desc");
    expect(snap.needsPlanning[0].nativeStatus).toBe("Ready");
    expect(snap.needsPlanning[0].scopeKey).toBe("acme/x");
  });

  it("references custom fields with cf[n] syntax in the JQL wrapper", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-jql-cf" }),
      cacheScope: "c-jql-cf", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    await p.fetchAIImplementSnapshot();

    // Search calls are the 2nd and 3rd fetches; listFields is the 1st.
    const bucketBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    const capacityBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string);
    expect(bucketBody.jql).toContain("cf[10100]");
    expect(bucketBody.jql).not.toContain("customfield_10100");
    expect(bucketBody.jql).not.toContain('"AI-Implement Status"');
    expect(capacityBody.jql).toContain("cf[10100]");
    expect(capacityBody.jql).not.toContain("customfield_10100");
    expect(capacityBody.jql).not.toContain('"AI-Implement Status"');
  });

  it("leaves non-customfield status overrides unchanged in the JQL wrapper", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-jql-passthrough" }),
      cacheScope: "c-jql-passthrough", siteUrl: "https://x",
      getMappings: () => ({
        "acme/x": jiraMapping({
          statusFieldOverride: "status",
          repoFieldOverride: "customfield_10101",
        }),
      }),
    });
    await p.fetchAIImplementSnapshot();

    const bucketBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    const capacityBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(bucketBody.jql).toContain("status in (Ready");
    expect(capacityBody.jql).toContain("status in (Planning");
  });

  it("counts capacity from the in-flight query", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([
        issue("20001", "P-10", "Planning", "acme/x"),
        issue("20002", "P-11", "Implementing", "acme/x"),
        issue("20003", "P-12", "Planning", "acme/x"),
      ]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-cap" }),
      cacheScope: "c-cap", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.inProgressCountsByScope).toEqual({ "acme/x": 3 });
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("filters out issues whose repo field doesn't match and fires onRepoFieldMismatch", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        issue("30001", "P-20", "Ready", "acme/x"),
        issue("30002", "P-21", "Ready", "acme/wrong"),
      ]))
      .mockResolvedValueOnce(searchOk([]));

    const onRepoFieldMismatch = vi.fn();
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-mis" }),
      cacheScope: "c-mis", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
      onRepoFieldMismatch,
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-20"]);
    expect(onRepoFieldMismatch).toHaveBeenCalledTimes(1);
    expect(onRepoFieldMismatch).toHaveBeenCalledWith("acme/x", "P-21", "acme/wrong");
  });

  it("does not double-fire onRepoFieldMismatch on second snapshot for the same issue", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([issue("40001", "P-30", "Ready", "acme/wrong")]))
      .mockResolvedValueOnce(searchOk([]))
      // Second snapshot — fields cache still warm; bucket + capacity again.
      .mockResolvedValueOnce(searchOk([issue("40001", "P-30", "Ready", "acme/wrong")]))
      .mockResolvedValueOnce(searchOk([]));

    const onRepoFieldMismatch = vi.fn();
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-dedup" }),
      cacheScope: "c-dedup", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
      onRepoFieldMismatch,
    });
    await p.fetchAIImplementSnapshot();
    await p.fetchAIImplementSnapshot();

    expect(onRepoFieldMismatch).toHaveBeenCalledTimes(1);
  });
});

describe("JiraProvider.fetchLifecycleStates", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); clearFieldCache(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("maps Jira resolution + status category to IssueLifecycleState", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        issues: [
          { id: "10001", key: "P-1", fields: { resolution: { name: "Done" }, status: { statusCategory: { key: "done" } } } },
          { id: "10002", key: "P-2", fields: { resolution: { name: "Won't Do" }, status: { statusCategory: { key: "done" } } } },
          { id: "10003", key: "P-3", fields: { resolution: null, status: { statusCategory: { key: "indeterminate" } } } },
        ],
      }),
    } as Response);

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-lf" }),
      cacheScope: "c-lf", siteUrl: "https://x", getMappings: () => ({}),
    });
    const states = await p.fetchLifecycleStates(["10001", "10002", "10003"]);
    expect(states.get("10001")).toBe("completed");
    expect(states.get("10002")).toBe("cancelled");
    expect(states.get("10003")).toBe("active");
  });

  it("returns empty map for empty input without making a fetch", async () => {
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-lf2" }),
      cacheScope: "c-lf2", siteUrl: "https://x", getMappings: () => ({}),
    });
    const states = await p.fetchLifecycleStates([]);
    expect(states.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("JiraProvider.findByKey", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the issue when found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "10001", key: "PROJ-1",
        fields: { summary: "Hello", description: "World", status: { name: "In Progress" } },
      }),
    } as Response);
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-fbk" }),
      cacheScope: "c-fbk", siteUrl: "https://x", getMappings: () => ({}),
    });
    const issue = await p.findByKey("PROJ-1");
    expect(issue).toEqual({
      id: "10001", identifier: "PROJ-1", title: "Hello", description: "World",
      scopeKey: "", nativeStatus: "In Progress",
    });
  });

  it("returns null on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 404, statusText: "Not Found", text: async () => "missing",
    } as Response);
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-fbk2" }),
      cacheScope: "c-fbk2", siteUrl: "https://x", getMappings: () => ({}),
    });
    expect(await p.findByKey("MISS-1")).toBeNull();
  });
});
