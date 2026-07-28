import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraProvider, createJiraProviderFromConfig } from "../../providers/jira.js";
import { JiraClient } from "../../providers/jira-client.js";
import { MissingProviderConfigError, type TicketingProvider } from "../../providers/types.js";
import { clearFieldCache } from "../../providers/jira-fields.js";
import { validateTicketingConfig } from "../../providers/ticketing-config.js";
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

  it("constructs in Basic-auth mode with email + token + siteUrl (no cloudId)", () => {
    const p = createJiraProviderFromConfig(
      { jiraToken: "api-tok", jiraEmail: "svc@example.com", jiraSiteUrl: "https://acme.atlassian.net" },
      noMappings,
    );
    expect(p.id).toBe("jira");
  });

  it("throws when jiraEmail is set but jiraSiteUrl is missing", () => {
    expect(() => createJiraProviderFromConfig({ jiraToken: "t", jiraEmail: "svc@example.com" }, noMappings))
      .toThrow(MissingProviderConfigError);
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
    profilesFieldOverride: string | null;
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
    profilesFieldOverride: overrides.profilesFieldOverride,
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
    await p.markPlanComplete("10001", "acme/x");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Plan Approved");
  });

  it("markPlanningFailed sets Planning Failed and posts a comment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty()) // setField PUT
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "c1" }) } as Response); // comment POST
    const p = makeProvider({ cacheScope: "c3", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanningFailed("10001", "acme/x", "boom");

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
    await p.markPrReady("10001", "acme/x", "https://github.com/acme/x/pull/42");

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
    await p.markImplementationFailed("10001", "acme/x", "kaboom");

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
    await p.clearWorkingState("10001", "acme/x");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Plan Approved");
  });

  it("markMerged sets status to Merged using the supplied scopeKey", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({ cacheScope: "c-merged", mappings: { "acme/x": jiraMapping() } });
    await p.markMerged("10001", "acme/x");
    // The last fetch must be a PUT to the issue's field with value "Merged"
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Merged");
  });

  it("multi-mapping markPlanComplete uses the supplied scopeKey directly (no repo-field read-back)", async () => {
    // Only the field-resolution fetch and the setField PUT should happen — the
    // provider must NOT fetch the issue to re-derive its scope. Supplying a
    // getIssue mock would go unused; omitting it proves no read-back occurs.
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE) // listFields (resolve field ids for "acme/y")
      .mockResolvedValueOnce(okEmpty()); // setField
    const p = makeProvider({
      cacheScope: "c8",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await p.markPlanComplete("10001", "acme/y");
    const calls = vi.mocked(fetch).mock.calls;
    // Exactly two fetches: field resolution + setField. No getIssue read-back.
    expect(calls.length).toBe(2);
    const lastCall = calls.at(-1)!;
    expect(String(lastCall[0])).toMatch(/\/issue\/10001/);
    expectStatusBody(lastCall, "Plan Approved");
  });

  it("multi-mapping markPlanComplete succeeds even when the issue's repo field would read back empty", async () => {
    // Regression: previously the provider re-derived scope by reading the
    // issue's repo field back from Jira; an empty/unreadable field threw
    // "No Jira mapping matched repoFieldValue=". With the scopeKey carried
    // through end-to-end, the read-back is gone and the call just succeeds.
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(okEmpty());
    const p = makeProvider({
      cacheScope: "c-empty-field",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await p.markPlanComplete("10001", "acme/x");
    expectStatusBody(vi.mocked(fetch).mock.calls.at(-1)!, "Plan Approved");
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
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
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
          profilesFieldOverride: "customfield_10200",
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
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
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

  it("matches a plain-text repo field that serializes as a bare string (not an option object)", async () => {
    // Text custom fields come back as a bare string, unlike single-select
    // option fields which come back as { value: string }.
    const textIssue = (id: string, key: string, status: string, repo: string) => ({
      id, key,
      fields: {
        summary: `summary-${key}`, description: null,
        customfield_10100: { value: status },
        customfield_10101: repo,
      },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([textIssue("50001", "P-40", "Ready", "acme/x")]))
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
      .mockResolvedValueOnce(searchOk([]));

    const onRepoFieldMismatch = vi.fn();
    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-text" }),
      cacheScope: "c-text", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
      onRepoFieldMismatch,
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-40"]);
    expect(onRepoFieldMismatch).not.toHaveBeenCalled();
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

  // --- Blocking relations (mirrors the Linear "blocks" inverse-relation skip) ---

  // A Jira "Blocks" issue link, as it appears in the blocked issue's `issuelinks`:
  // `inwardIssue` present ⇒ this issue "is blocked by" that issue.
  const blockedByLink = (statusCategoryKey: string) => ({
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key: "BLK-1", fields: { status: { statusCategory: { key: statusCategoryKey } } } },
  });

  // The other direction: this issue blocks something else (it is not itself blocked).
  const blocksOtherLink = () => ({
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    outwardIssue: { key: "OTH-1", fields: { status: { statusCategory: { key: "new" } } } },
  });

  const withLinks = (
    iss: ReturnType<typeof issue>,
    links: unknown[],
  ) => ({ ...iss, fields: { ...iss.fields, issuelinks: links } });

  it("requests the issuelinks field in the bucket search", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-links-field" }),
      cacheScope: "c-links-field", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    await p.fetchAIImplementSnapshot();

    const bucketBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(bucketBody.fields).toContain("issuelinks");
  });

  it("skips an issue blocked by an incomplete issue", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        withLinks(issue("50001", "P-40", "Ready", "acme/x"), [blockedByLink("indeterminate")]),
        issue("50002", "P-41", "Ready", "acme/x"),
      ]))
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-blocked" }),
      cacheScope: "c-blocked", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-41"]);
  });

  it("includes an issue whose blocker is already done", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        withLinks(issue("50003", "P-42", "Ready", "acme/x"), [blockedByLink("done")]),
      ]))
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-blk-done" }),
      cacheScope: "c-blk-done", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-42"]);
  });

  it("includes an issue that blocks others but is not itself blocked", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        withLinks(issue("50004", "P-43", "Ready", "acme/x"), [blocksOtherLink()]),
      ]))
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-blocks-other" }),
      cacheScope: "c-blocks-other", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-43"]);
  });

  it("includes an issue with no issuelinks field", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([issue("50005", "P-44", "Ready", "acme/x")]))
      .mockResolvedValueOnce(searchOk([])) // parent in (...) children query
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-no-links" }),
      cacheScope: "c-no-links", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-44"]);
  });

  it("skips an issue with a mix of done and incomplete blockers", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([
        withLinks(issue("50006", "P-45", "Ready", "acme/x"), [
          blockedByLink("done"),
          blockedByLink("indeterminate"),
        ]),
      ]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-blk-mix" }),
      cacheScope: "c-blk-mix", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning).toEqual([]);
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

// --- Feature-branch grouping (mirrors linear.test.ts) ---
import { JiraProvider as JiraProviderFB } from "../../providers/jira.js";

describe("JiraProvider.fetchAIImplementSnapshot — feature branches", () => {
  // Build a JiraIssue with the overridden status (10100) + repo (10101) custom fields.
  const issue = (
    key: string,
    status: string,
    repo: string,
    extra: { parentKey?: string | null; statusCategory?: string } = {},
  ) => ({
    id: `id-${key}`,
    key,
    fields: {
      summary: key,
      description: null,
      issuelinks: [],
      parent: extra.parentKey ? { key: extra.parentKey } : null,
      status: { statusCategory: { key: extra.statusCategory ?? "indeterminate" } },
      customfield_10100: status ? { value: status } : null,
      customfield_10101: { value: repo },
    },
  });

  // Fake JiraClient: matches each searchJql call by a substring of its JQL.
  const fakeClient = (routes: Array<{ when: RegExp; issues: unknown[] }>) =>
    ({
      async searchJql(jql: string, fields: string[]) {
        const issues = (routes.find((x) => x.when.test(jql))?.issues ?? []) as Array<{
          id: string;
          key: string;
          fields: Record<string, unknown>;
        }>;
        // Simulate Jira REST field projection: a query that does not request
        // "parent" gets no parent in its results.
        if (fields && !fields.includes("parent")) {
          return issues.map((i) => ({ ...i, fields: { ...i.fields, parent: undefined } }));
        }
        return issues;
      },
    }) as unknown as import("../../providers/jira-client.js").JiraClient;

  const makeProvider = (client: import("../../providers/jira-client.js").JiraClient) =>
    new JiraProviderFB({
      client,
      cacheScope: "c",
      siteUrl: "https://x",
      getMappings: () => ({
        m1: jiraMapping({
          repoFieldValue: "acme/x",
          statusFieldOverride: "customfield_10100",
          repoFieldOverride: "customfield_10101",
          profilesFieldOverride: "customfield_10200",
        }),
      }),
    });

  it("a leaf under a designated parent targets the parent's feature-branch chain", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })] },
      { when: /parent in/, issues: [] }, // OOL-96 has no children → leaf
      { when: /key in/, issues: [issue("OOL-78", "Implementing", "acme/x", { parentKey: null })] }, // ancestor is designated
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-96")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    expect(leaf.parentRef).toEqual({ identifier: "OOL-78" });
  });

  it("a leaf under an UNdesignated parent gets no chain (PRs to base)", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-50", "Ready", "acme/x", { parentKey: "OOL-40" })] },
      { when: /parent in/, issues: [] },
      { when: /key in/, issues: [issue("OOL-40", "", "acme/x")] }, // status unset → not designated
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "OOL-50")!;
    expect(leaf.featureBranchChain).toBeUndefined();
  });

  it("cascades the chain through designated grandparents (base-most first)", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-99", "Ready", "acme/x", { parentKey: "OOL-96" })] },
      { when: /parent in/, issues: [] },
      // ancestor walk: level 1 returns OOL-96 (parent OOL-78); level 2 returns OOL-78 (no parent)
      { when: /key in \("OOL-96"\)/, issues: [issue("OOL-96", "Ready", "acme/x", { parentKey: "OOL-78" })] },
      { when: /key in \("OOL-78"\)/, issues: [issue("OOL-78", "Ready", "acme/x", { parentKey: null })] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "OOL-99")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }, { identifier: "OOL-96", mode: "feature" }]);
  });

  it("skips a feature-node parent while any designated child is in flight", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-78", "Ready", "acme/x")] },
      {
        when: /parent in/,
        issues: [
          issue("OOL-78-c0", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
          issue("OOL-78-c1", "Implementing", "acme/x", { parentKey: "OOL-78", statusCategory: "indeterminate" }),
        ],
      },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("dispatches a feature-node parent once all designated children are terminal, onto its own branch", async () => {
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: "Closing work spec." } };
    const client = fakeClient([
      { when: /in \(Ready/, issues: [parentWithSpec] },
      {
        when: /parent in/,
        issues: [
          issue("OOL-78-c0", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
          issue("OOL-78-c1", "", "acme/x", { parentKey: "OOL-78", statusCategory: "indeterminate" }), // undesignated → no gate
        ],
      },
      { when: /key in/, issues: [] }, // OOL-78 has no parent
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
  });

  it("treats a child merged via markMerged (custom status Merged, native status not done) as terminal", async () => {
    // markMerged only sets the AI-Implement Status custom field — native status
    // stays untouched. The gating check must accept that as terminal or the
    // feature-node parent would stay blocked forever after a normal merge.
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: "Closing work spec." } };
    const client = fakeClient([
      { when: /in \(Ready/, issues: [parentWithSpec] },
      {
        when: /parent in/,
        issues: [
          issue("OOL-78-c0", "Merged", "acme/x", { parentKey: "OOL-78", statusCategory: "indeterminate" }),
        ],
      },
      { when: /key in/, issues: [] }, // OOL-78 has no parent
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
  });

  it("skips a parent whose children are not yet designated (race guard)", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-78", "Ready", "acme/x")] },
      { when: /parent in/, issues: [issue("OOL-78-c0", "", "acme/x", { parentKey: "OOL-78" })] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("fails closed when the children (gating) query errors: candidates are deferred, not dispatched", async () => {
    const client = {
      async searchJql(jql: string) {
        if (/parent in/.test(jql)) throw new Error("Jira unavailable");
        if (/in \(Ready/.test(jql)) return [issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })];
        return [];
      },
    } as unknown as import("../../providers/jira-client.js").JiraClient;
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    // Can't tell a leaf from a feature-node parent once gating failed → defer everything.
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("fails open when only the ancestor walk errors: candidate dispatches as a leaf targeting base", async () => {
    const client = {
      async searchJql(jql: string) {
        if (/key in/.test(jql)) throw new Error("Jira unavailable");
        if (/parent in/.test(jql)) return []; // OOL-96 has no children → leaf
        if (/in \(Ready/.test(jql)) return [issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })];
        return [];
      },
    } as unknown as import("../../providers/jira-client.js").JiraClient;
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-96")!;
    expect(leaf).toBeDefined();
    expect(leaf.featureBranchChain).toBeUndefined();
  });

  it("finalizes an empty-spec feature-node-ready parent instead of dispatching", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("OOL-78", "Ready", "acme/x")] },
      {
        when: /parent in/,
        issues: [
          issue("OOL-78-c0", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
        ],
      },
      { when: /key in/, issues: [] }, // OOL-78 has no parent
    ]);
    // OOL-78's description is null (blank spec) in the default issue() helper
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
    expect(snap.parentsToFinalize).toEqual([
      { issueId: "id-OOL-78", identifier: "OOL-78", scopeKey: "m1" },
    ]);
  });

  it("dispatches a non-empty-spec feature-node-ready parent normally (no regression)", async () => {
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: "## Do the work\n\nActual spec here." } };
    const client = fakeClient([
      { when: /in \(Ready/, issues: [parentWithSpec] },
      {
        when: /parent in/,
        issues: [
          issue("OOL-78-c0", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
        ],
      },
      { when: /key in/, issues: [] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent).toBeDefined();
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    expect(snap.parentsToFinalize).toEqual([]);
  });
});

describe("JiraProvider.fetchAIImplementSnapshot — Epic Link hierarchy (classic projects)", () => {
  beforeEach(() => { clearFieldCache(); });
  afterEach(() => { clearFieldCache(); });

  const FIELDS = [
    { id: "customfield_10100", name: "AI-Implement Status", custom: true },
    { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
    { id: "customfield_10014", name: "Epic Link", custom: true },
  ];

  // Issue with an optional native `parent` and an optional classic Epic Link (cf 10014).
  const issue = (
    key: string,
    status: string,
    repo: string,
    extra: { parentKey?: string | null; epicLink?: string | null; statusCategory?: string } = {},
  ) => ({
    id: `id-${key}`,
    key,
    fields: {
      summary: key,
      description: null,
      issuelinks: [],
      parent: extra.parentKey ? { key: extra.parentKey } : null,
      status: { statusCategory: { key: extra.statusCategory ?? "indeterminate" } },
      customfield_10100: status ? { value: status } : null,
      customfield_10101: { value: repo },
      customfield_10014: extra.epicLink ?? null,
    },
  });

  const client = (routes: Array<{ when: RegExp; issues: unknown[] }>) =>
    ({
      async listFields() { return FIELDS; },
      async searchJql(jql: string, fields: string[]) {
        const issues = (routes.find((x) => x.when.test(jql))?.issues ?? []) as Array<{
          id: string;
          key: string;
          fields: Record<string, unknown>;
        }>;
        if (fields && !fields.includes("parent")) {
          return issues.map((i) => ({ ...i, fields: { ...i.fields, parent: undefined } }));
        }
        return issues;
      },
    }) as unknown as import("../../providers/jira-client.js").JiraClient;

  // No status/repo overrides → fields() calls listFields and resolves the Epic Link field id.
  const provider = (c: import("../../providers/jira-client.js").JiraClient) =>
    new JiraProviderFB({
      client: c,
      cacheScope: "epic-scope",
      siteUrl: "https://x",
      getMappings: () => ({ m1: jiraMapping({ repoFieldValue: "acme/x" }) }),
    });

  it("attributes an Epic-Link child to its epic and blocks the epic while that child is in flight", async () => {
    const c = client([
      { when: /in \(Ready/, issues: [issue("OOL-EP", "Ready", "acme/x")] }, // epic, no native parent
      {
        when: /parent in/, // childrenJql ORs the Epic Link clause; the in-flight child is linked via Epic Link only
        issues: [issue("OOL-S", "Implementing", "acme/x", { epicLink: "OOL-EP", statusCategory: "indeterminate" })],
      },
    ]);
    const snap = await provider(c).fetchAIImplementSnapshot();
    // Pre-fix this epic looked like a leaf (epic-link child dropped) and dispatched prematurely.
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("an Epic-Link leaf targets its epic's feature branch", async () => {
    const c = client([
      { when: /in \(Ready/, issues: [issue("OOL-S", "Plan Approved", "acme/x", { epicLink: "OOL-EP" })] },
      { when: /parent in/, issues: [] }, // story has no children → leaf
      { when: /key in/, issues: [issue("OOL-EP", "Implementing", "acme/x")] }, // epic is designated
    ]);
    const snap = await provider(c).fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-S")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-EP", mode: "feature" }]);
    expect(leaf.parentRef).toEqual({ identifier: "OOL-EP" });
  });

  it("rolls up an Epic-Link feature node (child attributed via Epic Link)", async () => {
    const c = client([
      { when: /statusCategory = Done/, issues: [issue("OOL-EP", "PR Ready", "acme/x", { statusCategory: "done" })] },
      { when: /parent in/, issues: [issue("OOL-S", "PR Ready", "acme/x", { epicLink: "OOL-EP", statusCategory: "done" })] },
    ]);
    const rollUps = await provider(c).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-EP", identifier: "OOL-EP", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-S"] }]);
  });
});

describe("JiraProvider.fetchFeatureNodeRollUps", () => {
  const issue = (key: string, status: string, repo: string, parentKey: string | null = null) => ({
    id: `id-${key}`, key,
    fields: {
      parent: parentKey ? { key: parentKey } : null,
      customfield_10100: status ? { value: status } : null,
      customfield_10101: { value: repo },
    },
  });
  const fakeClient = (routes: Array<{ when: RegExp; issues: unknown[] }>) =>
    ({
      async searchJql(jql: string, fields: string[]) {
        const issues = (routes.find((x) => x.when.test(jql))?.issues ?? []) as Array<{
          id: string;
          key: string;
          fields: Record<string, unknown>;
        }>;
        // Simulate Jira REST field projection: a query that does not request
        // "parent" gets no parent in its results.
        if (fields && !fields.includes("parent")) {
          return issues.map((i) => ({ ...i, fields: { ...i.fields, parent: undefined } }));
        }
        return issues;
      },
    }) as unknown as import("../../providers/jira-client.js").JiraClient;
  const makeProvider = (client: import("../../providers/jira-client.js").JiraClient) =>
    new JiraProvider({
      client, cacheScope: "c", siteUrl: "https://x",
      getMappings: () => ({
        m1: jiraMapping({ repoFieldValue: "acme/x", statusFieldOverride: "customfield_10100", repoFieldOverride: "customfield_10101", profilesFieldOverride: "customfield_10200" }),
      }),
    });

  it("rolls a completed feature node into its designated parent (auto-merge → parentIdentifier set)", async () => {
    const client = fakeClient([
      { when: /statusCategory = Done/, issues: [issue("OOL-90", "PR Ready", "acme/x", "OOL-78")] }, // completed node w/ parent
      { when: /parent in/, issues: [issue("OOL-90-c", "PR Ready", "acme/x", "OOL-90")] },           // it has a designated child → feature node
      { when: /key in/, issues: [issue("OOL-78", "Ready", "acme/x", null)] },                       // parent is designated
    ]);
    const rollUps = await makeProvider(client).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-90", identifier: "OOL-90", scopeKey: "m1", mode: "feature", parent: { identifier: "OOL-78", mode: "feature" }, childIdentifiers: ["OOL-90-c"] }]);
  });

  it("top-of-tree feature node → parentIdentifier null (human feature→base PR)", async () => {
    const client = fakeClient([
      { when: /statusCategory = Done/, issues: [issue("OOL-78", "PR Ready", "acme/x", null)] },
      { when: /parent in/, issues: [issue("OOL-78-c", "PR Ready", "acme/x", "OOL-78")] },
    ]);
    const rollUps = await makeProvider(client).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-78", identifier: "OOL-78", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-78-c"] }]);
  });

  it("excludes completed issues that are not feature nodes (no designated children)", async () => {
    const client = fakeClient([
      { when: /statusCategory = Done/, issues: [issue("OOL-1", "PR Ready", "acme/x", null)] },
      { when: /parent in/, issues: [] }, // no children → not a feature node
    ]);
    expect(await makeProvider(client).fetchFeatureNodeRollUps()).toEqual([]);
  });

  it("excludes a completed issue whose own AI-Implement Status is unset (not a designated node)", async () => {
    const client = fakeClient([
      { when: /statusCategory = Done/, issues: [issue("OOL-5", "", "acme/x", null)] },
      { when: /parent in/, issues: [issue("OOL-5-c", "PR Ready", "acme/x", "OOL-5")] },
    ]);
    expect(await makeProvider(client).fetchFeatureNodeRollUps()).toEqual([]);
  });

  it("sets parentIdentifier null when the parent exists but is not itself designated", async () => {
    const client = fakeClient([
      { when: /statusCategory = Done/, issues: [issue("OOL-90", "PR Ready", "acme/x", "OOL-70")] },
      { when: /parent in/, issues: [issue("OOL-90-c", "PR Ready", "acme/x", "OOL-90")] },
      { when: /key in/, issues: [issue("OOL-70", "", "acme/x", null)] },
    ]);
    const rollUps = await makeProvider(client).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-90", identifier: "OOL-90", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-90-c"] }]);
  });
});

// --- Mode resolution from ai-implement.yml in issue descriptions ---

describe("JiraProvider — grouping mode from ai-implement.yml", () => {
  // ADF document with a codeBlock carrying the multi-issue config.
  const ADF_MULTI = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Group of unrelated work." }] },
      {
        type: "codeBlock",
        attrs: { language: "yaml" },
        content: [{ type: "text", text: '# ai-implement.yml\nfeature_branch:\n  mode: "multi-issue"' }],
      },
    ],
  };

  const PLAIN_MULTI = '```\n# ai-implement.yml\nfeature_branch:\n  mode: "multi-issue"\n```';

  const issue = (
    key: string,
    status: string,
    repo: string,
    extra: {
      parentKey?: string | null;
      statusCategory?: string;
      description?: unknown;
    } = {},
  ) => ({
    id: `id-${key}`,
    key,
    fields: {
      summary: key,
      description: extra.description ?? null,
      issuelinks: [],
      parent: extra.parentKey ? { key: extra.parentKey } : null,
      status: { statusCategory: { key: extra.statusCategory ?? "indeterminate" } },
      customfield_10100: status ? { value: status } : null,
      customfield_10101: { value: repo },
    },
  });

  const fakeClient = (routes: Array<{ when: RegExp; issues: unknown[] }>) =>
    ({
      async searchJql(jql: string, fields: string[]) {
        const issues = (routes.find((x) => x.when.test(jql))?.issues ?? []) as Array<{
          id: string;
          key: string;
          fields: Record<string, unknown>;
        }>;
        if (fields && !fields.includes("parent")) {
          return issues.map((i) => ({ ...i, fields: { ...i.fields, parent: undefined } }));
        }
        return issues;
      },
    }) as unknown as import("../../providers/jira-client.js").JiraClient;

  const makeProvider = (client: import("../../providers/jira-client.js").JiraClient) =>
    new JiraProviderFB({
      client,
      cacheScope: "c-mode",
      siteUrl: "https://x",
      getMappings: () => ({
        m1: jiraMapping({
          repoFieldValue: "acme/x",
          statusFieldOverride: "customfield_10100",
          repoFieldOverride: "customfield_10101",
          profilesFieldOverride: "customfield_10200",
        }),
      }),
    });

  it("reads multi-issue mode from an ADF code block", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })] },
      { when: /parent in/, issues: [] },
      { when: /key in/, issues: [issue("BAC-1", "Implementing", "acme/x", { description: ADF_MULTI })] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "multi-issue" }]);
  });

  it("reads multi-issue mode from a plain-string description", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })] },
      { when: /parent in/, issues: [] },
      { when: /key in/, issues: [issue("BAC-1", "Implementing", "acme/x", { description: PLAIN_MULTI })] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "multi-issue" }]);
  });

  it("leaves feature-node behaviour unchanged with no ai-implement.yml", async () => {
    const client = fakeClient([
      { when: /in \(Ready/, issues: [issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })] },
      { when: /parent in/, issues: [] },
      { when: /key in/, issues: [issue("BAC-1", "Implementing", "acme/x")] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "feature" }]);
  });

  it("strips the config block from the description handed to the runner", async () => {
    const client = fakeClient([
      {
        when: /in \(Ready/,
        issues: [issue("BAC-1", "Ready", "acme/x", { description: ADF_MULTI })],
      },
      {
        when: /parent in/,
        issues: [issue("BAC-1-c", "Merged", "acme/x", { parentKey: "BAC-1", statusCategory: "indeterminate" })],
      },
      { when: /key in/, issues: [] },
    ]);
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "BAC-1")!;
    expect(parent.description).toBe("Group of unrelated work.");
    expect(parent.description).not.toContain("feature_branch");
  });

  it("defaults ancestor modes to feature when the ancestor walk fails (fails open)", async () => {
    const client = {
      async searchJql(jql: string) {
        if (/key in/.test(jql)) throw new Error("Jira unavailable");
        if (/parent in/.test(jql)) return [];
        if (/in \(Ready/.test(jql)) return [issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })];
        return [];
      },
    } as unknown as import("../../providers/jira-client.js").JiraClient;
    const snap = await makeProvider(client).fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf).toBeDefined();
    expect(leaf.featureBranchChain).toBeUndefined();
  });

  it("carries modes onto roll-ups", async () => {
    const rollupIssue = (
      key: string,
      status: string,
      repo: string,
      parentKey: string | null = null,
      description: unknown = null,
    ) => ({
      id: `id-${key}`,
      key,
      fields: {
        description,
        parent: parentKey ? { key: parentKey } : null,
        customfield_10100: status ? { value: status } : null,
        customfield_10101: { value: repo },
      },
    });

    const client = fakeClient([
      {
        when: /statusCategory = Done/,
        issues: [rollupIssue("BAC-1", "PR Ready", "acme/x", null, ADF_MULTI)],
      },
      {
        when: /parent in/,
        issues: [rollupIssue("BAC-2", "PR Ready", "acme/x", "BAC-1")],
      },
    ]);
    const provider = makeProvider(client);
    const rollUps = await provider.fetchFeatureNodeRollUps();
    expect(rollUps).toHaveLength(1);
    expect(rollUps[0].mode).toBe("multi-issue");
    expect(rollUps[0].parent).toBeNull();
    expect(rollUps[0].childIdentifiers).toEqual(["BAC-2"]);
  });
});

describe("JiraProvider.childrenJql (Epic Link fallback)", () => {
  const provider = () =>
    new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c" }),
      cacheScope: "c",
      siteUrl: "https://x",
      getMappings: () => ({}),
    }) as unknown as { childrenJql(keys: string[], ids: Record<string, string | undefined>): string };

  it("returns a plain parent-in query when no Epic Link field is resolved", () => {
    const jql = provider().childrenJql(["A-1", "A-2"], {
      statusFieldId: "customfield_10100",
      repoFieldId: "customfield_10101",
    });
    expect(jql).toBe('parent in ("A-1","A-2")');
  });

  it("ORs the Epic Link clause (cf[N]) when epicLinkFieldId is resolved", () => {
    const jql = provider().childrenJql(["A-1", "A-2"], {
      statusFieldId: "customfield_10100",
      repoFieldId: "customfield_10101",
      epicLinkFieldId: "customfield_10014",
    });
    expect(jql).toContain('parent in ("A-1","A-2")');
    expect(jql).toContain('cf[10014] in ("A-1","A-2")');
    expect(jql.startsWith("(")).toBe(true);
    expect(jql.endsWith(")")).toBe(true);
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

describe("JiraProvider.fetchAIImplementSnapshot — profiles field", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    clearFieldCache();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const FIELDS_WITH_PROFILES = {
    ok: true,
    json: async () => [
      { id: "customfield_10100", name: "AI-Implement Status", custom: true, schema: {} },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true, schema: {} },
      { id: "customfield_10200", name: "AI-Implement Profiles", custom: true, schema: {} },
    ],
  } as Response;

  const searchOk = (issues: unknown[]): Response =>
    ({ ok: true, json: async () => ({ issues }) }) as Response;

  const profilesIssue = (profiles: unknown) => ({
    id: "10001", key: "P-1",
    fields: {
      summary: "P-1",
      description: null,
      customfield_10100: { value: "Ready" },
      customfield_10101: { value: "acme/x" },
      customfield_10200: profiles,
    },
  });

  it("maps multi-select profile values to issue.profiles", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_WITH_PROFILES)
      .mockResolvedValueOnce(searchOk([profilesIssue([{ value: "backend" }, { value: "webapp" }])]))
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-prof-multi" }),
      cacheScope: "c-prof-multi", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toEqual(["backend", "webapp"]);
  });

  it("leaves profiles absent when the multi-select is empty", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_WITH_PROFILES)
      .mockResolvedValueOnce(searchOk([profilesIssue([])]))
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-prof-empty" }),
      cacheScope: "c-prof-empty", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
  });

  it("leaves profiles absent when the field value is null", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_WITH_PROFILES)
      .mockResolvedValueOnce(searchOk([profilesIssue(null)]))
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-prof-null" }),
      cacheScope: "c-prof-null", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
  });

  it("leaves profiles absent when the profiles field is not present in Jira (profilesFieldId null)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(FIELDS_RESPONSE)
      .mockResolvedValueOnce(searchOk([{
        id: "10001", key: "P-1",
        fields: {
          summary: "P-1",
          description: null,
          customfield_10100: { value: "Ready" },
          customfield_10101: { value: "acme/x" },
        },
      }]))
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-prof-no-field" }),
      cacheScope: "c-prof-no-field", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": jiraMapping() }),
    });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("uses profilesFieldOverride to resolve profiles without calling listFields for all three overrides", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(searchOk([{
        id: "10001", key: "P-1",
        fields: {
          summary: "P-1",
          description: null,
          customfield_10100: { value: "Ready" },
          customfield_10101: { value: "acme/x" },
          customfield_10200: [{ value: "mobile" }],
        },
      }]))
      .mockResolvedValueOnce(searchOk([]))
      .mockResolvedValueOnce(searchOk([]));

    const mappingWithOverrides: RepoMapping = {
      ...jiraMapping({
        statusFieldOverride: "customfield_10100",
        repoFieldOverride: "customfield_10101",
      }),
      ticketingConfig: {
        kind: "jira",
        jql: "project = TEST",
        repoFieldValue: "acme/x",
        statusFieldOverride: "customfield_10100",
        repoFieldOverride: "customfield_10101",
        profilesFieldOverride: "customfield_10200",
      },
    };

    const p = new JiraProvider({
      client: new JiraClient({ token: "t", cloudId: "c-prof-override" }),
      cacheScope: "c-prof-override", siteUrl: "https://x",
      getMappings: () => ({ "acme/x": mappingWithOverrides }),
    });
    const snap = await p.fetchAIImplementSnapshot();
    // 3 fetches total: bucket search + children query + capacity search (no listFields call)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
    expect(snap.needsPlanning[0].profiles).toEqual(["mobile"]);
  });
});

describe("validateTicketingConfig — profilesFieldOverride passthrough", () => {
  it("passes through profilesFieldOverride as a string when provided", () => {
    const result = validateTicketingConfig("jira", {
      kind: "jira",
      jql: "project = TEST",
      repoFieldValue: "acme/x",
      profilesFieldOverride: "customfield_10200",
    });
    if (result.kind !== "jira") throw new Error("expected jira");
    expect(result.profilesFieldOverride).toBe("customfield_10200");
  });

  it("normalizes absent profilesFieldOverride to null", () => {
    const result = validateTicketingConfig("jira", {
      kind: "jira",
      jql: "project = TEST",
      repoFieldValue: "acme/x",
    });
    if (result.kind !== "jira") throw new Error("expected jira");
    expect(result.profilesFieldOverride).toBeNull();
  });

  it("normalizes non-string profilesFieldOverride to null", () => {
    const result = validateTicketingConfig("jira", {
      kind: "jira",
      jql: "project = TEST",
      repoFieldValue: "acme/x",
      profilesFieldOverride: 42,
    });
    if (result.kind !== "jira") throw new Error("expected jira");
    expect(result.profilesFieldOverride).toBeNull();
  });
});
