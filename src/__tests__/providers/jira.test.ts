import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { JiraProvider, createJiraProviderFromConfig } from "../../providers/jira.js";
import { JiraApiError, JiraClient, type JiraIssue } from "../../providers/jira-client.js";
import { MissingProviderConfigError, TrackerUnavailableError, type TicketingProvider } from "../../providers/types.js";
import { clearFieldCache } from "../../providers/jira-fields.js";
import { validateTicketingConfig } from "../../providers/ticketing-config.js";
import { validateIssueBaseBranch } from "../../base-branch.js";
import type { RepoMapping } from "../../config.js";
import { makeIssue, makeMapping } from "../helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply, type ReplyInit, type Routes } from "../helpers/fake-fetch.js";

// The client reaches Jira through the OAuth gateway for cloud id "c", so every request path starts here.
const API = "/ex/jira/c/rest/api/3";
const FIELDS = `GET ${API}/field` as const;
const SEARCH = `POST ${API}/search/jql` as const;
const STATUS_READ = `GET ${API}/issue/10001` as const;
const STATUS_WRITE = `PUT ${API}/issue/10001` as const;
const COMMENT = `POST ${API}/issue/10001/comment` as const;

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
    expect(p.issueUrl(makeIssue({ identifier: "PROJ-123" }))).toBe("https://acme.atlassian.net/browse/PROJ-123");
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

// A Jira mapping as the store reads one back: validation stores every field override as a string or null,
// and the repo field value names the mapping's own repository.
const jiraMapping = (
  overrides: Partial<{
    jql: string;
    repoFieldValue: string;
    statusFieldOverride: string | null;
    repoFieldOverride: string | null;
    profilesFieldOverride: string | null;
    baseBranchFieldOverride: string | null;
  }> = {},
): RepoMapping => {
  const repoFieldValue = overrides.repoFieldValue ?? "acme/x";
  const [owner, repo] = repoFieldValue.split("/");
  return makeMapping({
    owner,
    repo,
    ticketingProvider: "jira",
    ticketingConfig: {
      kind: "jira",
      jql: overrides.jql ?? "project = P",
      repoFieldValue,
      statusFieldOverride: overrides.statusFieldOverride ?? null,
      repoFieldOverride: overrides.repoFieldOverride ?? null,
      profilesFieldOverride: overrides.profilesFieldOverride ?? null,
      baseBranchFieldOverride: overrides.baseBranchFieldOverride ?? null,
    },
  });
};

// All four field ids set by override, so the provider never lists the instance's fields.
const ALL_OVERRIDES = {
  statusFieldOverride: "customfield_10100",
  repoFieldOverride: "customfield_10101",
  profilesFieldOverride: "customfield_10200",
  baseBranchFieldOverride: "customfield_10300",
};

// The field list's entries for the two single-select fields, with the schema Jira gives a custom select.
const selectField = (id: string, name: string) => ({
  id, name, custom: true,
  schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: Number(id.replace("customfield_", "")) },
});

const FIELDS_REPLY: ReplyInit = {
  json: [selectField("customfield_10100", "AI-Implement Status"), selectField("customfield_10101", "AI-Implement Repo")],
};

// A description as REST API v3 sends it: an Atlassian Document Format document, one paragraph per argument.
const adfDoc = (...paragraphs: string[]) => ({
  type: "doc",
  version: 1,
  content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

// Jira's error body for a failed request.
const jiraError = (status: number, message: string): ReplyInit => ({ status, json: { errorMessages: [message], errors: {} } });

function makeProvider(opts: {
  cacheScope: string;
  mappings: Record<string, RepoMapping>;
  onRepoFieldMismatch?: (mappingId: string, issueKey: string, actual: string) => void;
}): JiraProvider {
  return new JiraProvider({
    client: new JiraClient({ token: "t", cloudId: "c" }),
    cacheScope: opts.cacheScope,
    siteUrl: "https://x",
    getMappings: () => opts.mappings,
    onRepoFieldMismatch: opts.onRepoFieldMismatch,
  });
}

type SearchRoute = { when: RegExp; issues?: JiraIssue[]; status?: number };

// Answers Jira's JQL search by the JQL each request carries, returning only the fields the
// request names, as Jira does. A search no route matches fails the test, even when the
// provider catches the error.
function jqlSearch(...routes: SearchRoute[]): Reply {
  const unmatched: string[] = [];
  onTestFinished(() => {
    if (unmatched.length > 0) throw new Error(`jqlSearch: no route for ${unmatched.join(" | ")}`);
  });
  return (call) => {
    const { jql, fields } = JSON.parse(call.body) as { jql: string; fields: string[] };
    const route = routes.find((r) => r.when.test(jql));
    if (!route) {
      unmatched.push(jql);
      throw new Error(`jqlSearch: no route for ${jql}`);
    }
    if (route.status) return jiraError(route.status, "Error in the JQL Query");
    const issues = (route.issues ?? []).map((issue) => ({
      ...issue,
      fields: Object.fromEntries(Object.entries(issue.fields).filter(([name]) => fields.includes(name))),
    }));
    return { json: { issues, isLast: true } };
  };
}

// The searches the provider runs, by the shape of their JQL.
const ready = (...issues: JiraIssue[]): SearchRoute => ({ when: /in \(Ready/, issues });
const inFlight = (...issues: JiraIssue[]): SearchRoute => ({ when: /in \(Planning/, issues });
const children = (...issues: JiraIssue[]): SearchRoute => ({ when: /parent in/, issues });
const keyIn = (...issues: JiraIssue[]): SearchRoute => ({ when: /^key in/, issues });
const completed = (...issues: JiraIssue[]): SearchRoute => ({ when: /statusCategory = Done/, issues });

const searchBodies = (fake: FakeFetch): Array<{ jql: string; fields: string[] }> =>
  fake.calls.filter((c) => c.path === `${API}/search/jql`).map((c) => JSON.parse(c.body));

describe("JiraProvider.postComment", () => {
  it("posts a comment with ADF-formatted body", async () => {
    const fake = fakeFetch({ [COMMENT]: { status: 201, json: { id: "10000" } } }).install();

    const p = makeProvider({ cacheScope: "c", mappings: {} });
    await p.postComment("10001", "Hello world");

    expect(fake.calls[0].url.href).toMatch(/\/rest\/api\/3\/issue\/10001\/comment$/);
    const body = JSON.parse(fake.calls[0].body);
    expect(body.body.type).toBe("doc");
    expect(body.body.content[0].type).toBe("paragraph");
  });
});

// --- Lifecycle status setters ---

describe("JiraProvider lifecycle status setters", () => {
  beforeEach(() => {
    clearFieldCache();
  });

  // setStatus pre-reads the current status before every non-Merged write (the
  // never-regress-Merged guard); this is that read's response for an issue at `value`.
  const statusRead = (value: string): ReplyInit => ({
    json: { id: "10001", key: "P-1", fields: { customfield_10100: { value } } },
  });
  const written: ReplyInit = { status: 204 };
  const commented: ReplyInit = { status: 201, json: { id: "10000" } };

  const methods = (fake: FakeFetch) => fake.calls.map((c) => c.method);
  const commentText = (fake: FakeFetch) =>
    JSON.parse(fake.calls.find((c) => c.method === "POST")!.body).body.content[0].content[0].text;
  function expectStatusBody(fake: FakeFetch, expected: string) {
    const body = JSON.parse(fake.calls.find((c) => c.method === "PUT")!.body);
    expect(body.fields.customfield_10100).toEqual({ value: expected });
  }

  it("markPlanningStarted sets status to Planning", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Implementing"), [STATUS_WRITE]: written }).install();
    const p = makeProvider({ cacheScope: "c1", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanningStarted("10001", "acme/x");
    expect(methods(fake)).toEqual(["GET", "GET", "PUT"]);
    expectStatusBody(fake, "Planning");
  });

  it("markPlanComplete sets status to Plan Approved (single-mapping shortcut)", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Implementing"), [STATUS_WRITE]: written }).install();
    const p = makeProvider({ cacheScope: "c2", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanComplete("10001", "acme/x");
    expect(methods(fake)).toEqual(["GET", "GET", "PUT"]);
    expectStatusBody(fake, "Plan Approved");
  });

  it("markPlanningFailed sets Planning Failed and posts a comment", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: statusRead("Implementing"),
      [STATUS_WRITE]: written,
      [COMMENT]: commented,
    }).install();
    const p = makeProvider({ cacheScope: "c3", mappings: { "acme/x": jiraMapping() } });
    const result = await p.markPlanningFailed("10001", "acme/x", "boom");
    expect(result).toBe(true);

    expect(methods(fake)).toEqual(["GET", "GET", "PUT", "POST"]);
    expectStatusBody(fake, "Planning Failed");
    expect(fake.calls[3].url.href).toMatch(/\/comment$/);
    expect(commentText(fake)).toContain("boom");
  });

  it("markImplementing sets status to Implementing", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Implementing"), [STATUS_WRITE]: written }).install();
    const p = makeProvider({ cacheScope: "c4", mappings: { "acme/x": jiraMapping() } });
    await p.markImplementing("10001", "acme/x");
    expect(methods(fake)).toEqual(["GET", "GET", "PUT"]);
    expectStatusBody(fake, "Implementing");
  });

  it("markPrReady sets PR Ready and posts a comment with the PR URL", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: statusRead("Implementing"), // current-status pre-read (Merged guard)
      [STATUS_WRITE]: written,
      [COMMENT]: commented,
    }).install();
    const p = makeProvider({ cacheScope: "c5", mappings: { "acme/x": jiraMapping() } });
    await p.markPrReady("10001", "acme/x", "https://github.com/acme/x/pull/42");

    expect(methods(fake)).toEqual(["GET", "GET", "PUT", "POST"]);
    expectStatusBody(fake, "PR Ready");
    expect(commentText(fake)).toContain("https://github.com/acme/x/pull/42");
  });

  it("markPlanningFailed skips its failure comment when the issue is already Merged", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Merged") }).install(); // guard pre-read
    const p = makeProvider({ cacheScope: "c3-merged", mappings: { "acme/x": jiraMapping() } });
    await p.markPlanningFailed("10001", "acme/x", "late boom");

    // Pre-read is the last request: no setField PUT, no "Planning failed" comment.
    expect(fake.calls).toHaveLength(2);
  });

  it("clearWorkingState refuses to reset an already-Merged issue (reaper max-age sweep)", async () => {
    // The reaper's resetTicket path also clears dedup; with the status write refused
    // the issue stays out of the Ready/"Plan Approved" dispatch bucket, so cleared
    // dedup cannot re-dispatch already-merged work.
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Merged") }).install(); // guard pre-read
    const p = makeProvider({ cacheScope: "c7-merged", mappings: { "acme/x": jiraMapping() } });
    await p.clearWorkingState("10001", "acme/x");
    // Pre-read is the last request: no setField PUT happened.
    expect(fake.calls).toHaveLength(2);
  });

  it("markPrReady leaves an already-Merged issue at Merged (late success report)", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Merged") }).install(); // current-status pre-read
    const p = makeProvider({ cacheScope: "c5-merged", mappings: { "acme/x": jiraMapping() } });
    await p.markPrReady("10001", "acme/x", "https://github.com/acme/x/pull/42");

    // No status write, no comment: the pre-read is the last request.
    expect(fake.calls).toHaveLength(2);
  });

  it("markImplementationFailed sets Implementation Failed and posts a comment", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: statusRead("Implementing"), // current-status pre-read (Merged guard)
      [STATUS_WRITE]: written,
      [COMMENT]: commented,
    }).install();
    const p = makeProvider({ cacheScope: "c6", mappings: { "acme/x": jiraMapping() } });
    const result = await p.markImplementationFailed("10001", "acme/x", "kaboom");
    expect(result).toBe(true);

    expect(methods(fake)).toEqual(["GET", "GET", "PUT", "POST"]);
    expectStatusBody(fake, "Implementation Failed");
    expect(commentText(fake)).toContain("kaboom");
  });

  it("markImplementationFailed leaves an already-Merged issue at Merged (late failure report)", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: statusRead("Merged"), // current-status pre-read
      [COMMENT]: commented,
    }).install();
    const p = makeProvider({ cacheScope: "c6-merged", mappings: { "acme/x": jiraMapping() } });
    await p.markImplementationFailed("10001", "acme/x", "late kaboom");

    // No setField PUT: the third request is the comment, and no request carries a status write.
    expect(methods(fake)).toEqual(["GET", "GET", "POST"]);
    for (const call of fake.calls) {
      const body = call.body ? JSON.parse(call.body) : {};
      expect(body?.fields?.customfield_10100).toBeUndefined();
    }
    expect(commentText(fake)).toContain("already merged");
    expect(commentText(fake)).toContain("late kaboom");
  });

  it("markImplementationFailed proceeds to mark failed when the status pre-read errors", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: jiraError(500, "Internal server error"), // pre-read fails
      [STATUS_WRITE]: written,
      [COMMENT]: commented,
    }).install();
    const p = makeProvider({ cacheScope: "c6-readfail", mappings: { "acme/x": jiraMapping() } });
    await p.markImplementationFailed("10001", "acme/x", "kaboom");

    expect(methods(fake)).toEqual(["GET", "GET", "PUT", "POST"]);
    expectStatusBody(fake, "Implementation Failed");
  });

  it("clearWorkingState resets status to Plan Approved", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Implementing"), [STATUS_WRITE]: written }).install();
    const p = makeProvider({ cacheScope: "c7", mappings: { "acme/x": jiraMapping() } });
    await p.clearWorkingState("10001", "acme/x");
    expect(methods(fake)).toEqual(["GET", "GET", "PUT"]);
    expectStatusBody(fake, "Plan Approved");
  });

  it("markMerged sets status to Merged using the supplied scopeKey", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_WRITE]: written }).install();
    const p = makeProvider({ cacheScope: "c-merged", mappings: { "acme/x": jiraMapping() } });
    await p.markMerged("10001", "acme/x");
    // The last request must be a PUT to the issue's field with value "Merged"
    expect(methods(fake)).toEqual(["GET", "PUT"]);
    expectStatusBody(fake, "Merged");
  });

  it("multi-mapping markPlanComplete uses the supplied scopeKey directly (no repo-field read-back)", async () => {
    // The provider must NOT fetch the issue to re-derive its scope. The one issue
    // read that DOES happen is setStatus's never-regress-Merged pre-read — a GET of
    // the status field only, requesting no repo field. Exactly three requests: field
    // resolution, the guard pre-read, and the setField PUT.
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [STATUS_READ]: statusRead("Implementing"), // guard pre-read
      [STATUS_WRITE]: written,
    }).install();
    const p = makeProvider({
      cacheScope: "c8",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await p.markPlanComplete("10001", "acme/y");
    expect(methods(fake)).toEqual(["GET", "GET", "PUT"]);
    // The guard pre-read asks for the status field only — no repo-field read-back.
    expect(fake.calls[1].url.searchParams.get("fields")).toBe("customfield_10100");
    expect(fake.calls[2].url.href).toMatch(/\/issue\/10001/);
    expectStatusBody(fake, "Plan Approved");
  });

  it("multi-mapping markPlanComplete succeeds even when the issue's repo field would read back empty", async () => {
    // Regression: previously the provider re-derived scope by reading the
    // issue's repo field back from Jira; an empty/unreadable field threw
    // "No Jira mapping matched repoFieldValue=". With the scopeKey carried
    // through end-to-end, the read-back is gone and the call just succeeds.
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [STATUS_READ]: statusRead("Implementing"), [STATUS_WRITE]: written }).install();
    const p = makeProvider({
      cacheScope: "c-empty-field",
      mappings: {
        "acme/x": jiraMapping({ repoFieldValue: "acme/x" }),
        "acme/y": jiraMapping({ repoFieldValue: "acme/y" }),
      },
    });
    await p.markPlanComplete("10001", "acme/x");
    expectStatusBody(fake, "Plan Approved");
  });
});

describe("JiraProvider.fetchAIImplementSnapshot", () => {
  beforeEach(() => {
    clearFieldCache();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // An issue as the bucket search returns it: every field it requests, links and assignee included.
  const issue = (
    id: string, key: string, status: string, repo: string,
    desc: unknown = null, summary = `summary-${key}`,
  ): JiraIssue => ({
    id, key,
    fields: {
      summary, description: desc,
      customfield_10100: { value: status },
      customfield_10101: { value: repo },
      issuelinks: [],
      assignee: null,
    },
  });

  it("refuses an invalid branch from the Jira snapshot instead of falling back to the default", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = issue("10001", "P-1", "Ready", "acme/x");
    fakeFetch({
      [SEARCH]: jqlSearch(ready({ ...raw, fields: { ...raw.fields, customfield_10300: "release..bad" } }), children(), inFlight()),
    }).install();
    const p = makeProvider({ cacheScope: "invalid-base", mappings: { "acme/x": jiraMapping(ALL_OVERRIDES) } });
    const snap = await p.fetchAIImplementSnapshot();
    const markFailed = vi.fn(async () => true);
    const lookup = vi.fn(async () => null);
    const result = await validateIssueBaseBranch({
      ghToken: "test", owner: "acme", repo: "x", issue: snap.needsPlanning[0],
      markFailed, getBranchShaImpl: lookup,
    });
    expect(result).toEqual({ refused: true });
    expect(markFailed).toHaveBeenCalledWith("10001", "acme/x", expect.stringContaining("invalid"));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("buckets issues by status field value", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(
          issue("10001", "P-1", "Ready", "acme/x"),
          issue("10002", "P-2", "Plan Approved", "acme/x", adfDoc("desc")),
        ),
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-snap-bucket", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-1"]);
    expect(snap.readyForImplementation.map((i) => i.identifier)).toEqual(["P-2"]);
    expect(snap.inProgressCountsByScope).toEqual({ "acme/x": 0 });
    expect(snap.readyForImplementation[0].description).toBe("desc");
    expect(snap.needsPlanning[0].nativeStatus).toBe("Ready");
    expect(snap.needsPlanning[0].scopeKey).toBe("acme/x");
  });

  it("references custom fields with cf[n] syntax in the JQL wrapper", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [SEARCH]: jqlSearch(ready(), inFlight()) }).install();

    const p = makeProvider({ cacheScope: "c-jql-cf", mappings: { "acme/x": jiraMapping() } });
    await p.fetchAIImplementSnapshot();

    const [bucketBody, capacityBody] = searchBodies(fake);
    expect(bucketBody.jql).toContain("cf[10100]");
    expect(bucketBody.jql).not.toContain("customfield_10100");
    expect(bucketBody.jql).not.toContain('"AI-Implement Status"');
    expect(capacityBody.jql).toContain("cf[10100]");
    expect(capacityBody.jql).not.toContain("customfield_10100");
    expect(capacityBody.jql).not.toContain('"AI-Implement Status"');
  });

  it("leaves non-customfield status overrides unchanged in the JQL wrapper", async () => {
    const fake = fakeFetch({ [SEARCH]: jqlSearch(ready(), inFlight()) }).install();

    const p = makeProvider({
      cacheScope: "c-jql-passthrough",
      mappings: { "acme/x": jiraMapping({ ...ALL_OVERRIDES, statusFieldOverride: "status" }) },
    });
    await p.fetchAIImplementSnapshot();

    const [bucketBody, capacityBody] = searchBodies(fake);
    expect(bucketBody.jql).toContain("status in (Ready");
    expect(capacityBody.jql).toContain("status in (Planning");
  });

  it("counts capacity from the in-flight query", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(),
        inFlight(
          issue("20001", "P-10", "Planning", "acme/x"),
          issue("20002", "P-11", "Implementing", "acme/x"),
          issue("20003", "P-12", "Planning", "acme/x"),
        ),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-cap", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.inProgressCountsByScope).toEqual({ "acme/x": 3 });
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("filters out issues whose repo field doesn't match and fires onRepoFieldMismatch", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(
          issue("30001", "P-20", "Ready", "acme/x"),
          issue("30002", "P-21", "Ready", "acme/wrong"),
        ),
        children(),
        inFlight(),
      ),
    }).install();

    const onRepoFieldMismatch = vi.fn();
    const p = makeProvider({ cacheScope: "c-mis", mappings: { "acme/x": jiraMapping() }, onRepoFieldMismatch });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-20"]);
    expect(onRepoFieldMismatch).toHaveBeenCalledTimes(1);
    expect(onRepoFieldMismatch).toHaveBeenCalledWith("acme/x", "P-21", "acme/wrong");
  });

  it("matches a plain-text repo field that serializes as a bare string (not an option object)", async () => {
    // Text custom fields come back as a bare string, unlike single-select
    // option fields which come back as { value: string }.
    const textIssue = (id: string, key: string, status: string, repo: string): JiraIssue => ({
      id, key,
      fields: {
        summary: `summary-${key}`, description: null,
        customfield_10100: { value: status },
        customfield_10101: repo,
      },
    });
    fakeFetch({
      [FIELDS]: {
        json: [
          selectField("customfield_10100", "AI-Implement Status"),
          {
            id: "customfield_10101", name: "AI-Implement Repo", custom: true,
            schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10101 },
          },
        ],
      },
      [SEARCH]: jqlSearch(ready(textIssue("50001", "P-40", "Ready", "acme/x")), children(), inFlight()),
    }).install();

    const onRepoFieldMismatch = vi.fn();
    const p = makeProvider({ cacheScope: "c-text", mappings: { "acme/x": jiraMapping() }, onRepoFieldMismatch });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-40"]);
    expect(onRepoFieldMismatch).not.toHaveBeenCalled();
  });

  it("does not double-fire onRepoFieldMismatch on second snapshot for the same issue", async () => {
    // Both snapshots run the bucket and capacity searches; the field cache stays warm for the second.
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(ready(issue("40001", "P-30", "Ready", "acme/wrong")), inFlight()),
    }).install();

    const onRepoFieldMismatch = vi.fn();
    const p = makeProvider({ cacheScope: "c-dedup", mappings: { "acme/x": jiraMapping() }, onRepoFieldMismatch });
    await p.fetchAIImplementSnapshot();
    await p.fetchAIImplementSnapshot();

    expect(onRepoFieldMismatch).toHaveBeenCalledTimes(1);
  });

  // --- Blocking relations (mirrors the Linear "blocks" inverse-relation skip) ---

  // A Jira "Blocks" issue link, as it appears in the blocked issue's `issuelinks`:
  // `inwardIssue` present ⇒ this issue "is blocked by" that issue.
  const blockedByLink = (statusCategoryKey: string, key = "BLK-1") => ({
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key, fields: { status: { statusCategory: { key: statusCategoryKey } } } },
  });

  // The other direction: this issue blocks something else (it is not itself blocked).
  const blocksOtherLink = () => ({
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    outwardIssue: { key: "OTH-1", fields: { status: { statusCategory: { key: "new" } } } },
  });

  const withLinks = (iss: JiraIssue, links: unknown[]): JiraIssue => ({ ...iss, fields: { ...iss.fields, issuelinks: links } });

  it("requests the issuelinks field in the bucket search", async () => {
    const fake = fakeFetch({ [FIELDS]: FIELDS_REPLY, [SEARCH]: jqlSearch(ready(), inFlight()) }).install();

    const p = makeProvider({ cacheScope: "c-links-field", mappings: { "acme/x": jiraMapping() } });
    await p.fetchAIImplementSnapshot();

    const [bucketBody] = searchBodies(fake);
    expect(bucketBody.fields).toContain("issuelinks");
  });

  it("skips an issue blocked by an incomplete issue", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(
          withLinks(issue("50001", "P-40", "Ready", "acme/x"), [blockedByLink("indeterminate")]),
          issue("50002", "P-41", "Ready", "acme/x"),
        ),
        keyIn(issue("60001", "BLK-1", "Implementing", "acme/x")), // merged-blocker lookup
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blocked", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-41"]);
  });

  it("includes an issue whose blocker is already done", async () => {
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(withLinks(issue("50003", "P-42", "Ready", "acme/x"), [blockedByLink("done")])),
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blk-done", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-42"]);
    // Nothing is gated (the only blocker is natively done), so the merged-blocker
    // lookup must not run: fields, bucket, children, capacity — exactly four requests.
    expect(fake.calls).toHaveLength(4);
  });

  it("includes an issue that blocks others but is not itself blocked", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(withLinks(issue("50004", "P-43", "Ready", "acme/x"), [blocksOtherLink()])),
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blocks-other", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-43"]);
  });

  it("includes an issue with no issuelinks field", async () => {
    const { issuelinks: _omitted, ...fields } = issue("50005", "P-44", "Ready", "acme/x").fields;
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(ready({ id: "50005", key: "P-44", fields }), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-no-links", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-44"]);
  });

  it("skips an issue with a mix of done and incomplete blockers", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(withLinks(issue("50006", "P-45", "Ready", "acme/x"), [blockedByLink("done", "BLK-1"), blockedByLink("indeterminate", "BLK-2")])),
        keyIn(issue("60003", "BLK-2", "Implementing", "acme/x")), // merged-blocker lookup: BLK-2 is not Merged
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blk-mix", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning).toEqual([]);
  });

  it("dispatches an issue whose blocker is natively unfinished but has AI-Implement Status = Merged", async () => {
    // markMerged sets only the custom field; the blocker's native status stays To Do.
    // The gate must treat such a blocker as complete or the cascade stalls forever.
    const fake = fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(withLinks(issue("50007", "P-46", "Ready", "acme/x"), [blockedByLink("new")])),
        keyIn(issue("60002", "BLK-1", "Merged", "acme/x")), // merged-blocker lookup
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blk-merged", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.identifier)).toEqual(["P-46"]);
    // The lookup queried exactly the natively-unfinished blocker keys.
    const lookupBody = searchBodies(fake).find((b) => b.jql.startsWith("key in"))!;
    expect(lookupBody.jql).toBe('key in ("BLK-1")');
  });

  it("keeps blocking when the merged-blocker lookup fails", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready(withLinks(issue("50008", "P-47", "Ready", "acme/x"), [blockedByLink("new")])),
        { when: /^key in/, status: 400 }, // lookup fails: Jira refuses JQL naming a deleted or unbrowsable key
        inFlight(), // no candidates → no children query
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-blk-lookup-fail", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning).toEqual([]);
  });
});

describe("JiraProvider.fetchLifecycleStates", () => {
  beforeEach(() => { clearFieldCache(); });

  it("maps Jira resolution + status category to IssueLifecycleState", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch({
        when: /^id in/,
        issues: [
          { id: "10001", key: "P-1", fields: { resolution: { name: "Done" }, status: { statusCategory: { key: "done" } } } },
          { id: "10002", key: "P-2", fields: { resolution: { name: "Won't Do" }, status: { statusCategory: { key: "done" } } } },
          { id: "10003", key: "P-3", fields: { resolution: null, status: { statusCategory: { key: "indeterminate" } } } },
        ],
      }),
    }).install();

    const p = makeProvider({ cacheScope: "c-lf", mappings: {} });
    const states = await p.fetchLifecycleStates(["10001", "10002", "10003"]);
    expect(states.get("10001")).toBe("completed");
    expect(states.get("10002")).toBe("cancelled");
    expect(states.get("10003")).toBe("active");
  });

  it("returns empty map for empty input without making a fetch", async () => {
    const fake = fakeFetch({}).install();
    const p = makeProvider({ cacheScope: "c-lf2", mappings: {} });
    const states = await p.fetchLifecycleStates([]);
    expect(states.size).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

// --- Feature-branch grouping (mirrors linear.test.ts) ---

describe("JiraProvider.fetchAIImplementSnapshot — feature branches", () => {
  // Build a JiraIssue with the overridden status (10100) + repo (10101) custom fields.
  const issue = (
    key: string,
    status: string,
    repo: string,
    extra: { parentKey?: string | null; statusCategory?: string } = {},
  ): JiraIssue => ({
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

  const provider = () =>
    makeProvider({ cacheScope: "c", mappings: { m1: jiraMapping({ jql: "project = OOL", ...ALL_OVERRIDES }) } });

  it("a leaf under a designated parent targets the parent's feature-branch chain", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })),
        children(), // OOL-96 has no children → leaf
        keyIn(issue("OOL-78", "Implementing", "acme/x", { parentKey: null })), // ancestor is designated
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-96")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    expect(leaf.parentRef).toEqual({ identifier: "OOL-78" });
  });

  it("a leaf under an UNdesignated parent gets no chain (PRs to base)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-50", "Ready", "acme/x", { parentKey: "OOL-40" })),
        children(),
        keyIn(issue("OOL-40", "", "acme/x")), // status unset → not designated
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "OOL-50")!;
    expect(leaf.featureBranchChain).toBeUndefined();
  });

  it("cascades the chain through designated grandparents (base-most first)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-99", "Ready", "acme/x", { parentKey: "OOL-96" })),
        children(),
        // ancestor walk: level 1 returns OOL-96 (parent OOL-78); level 2 returns OOL-78 (no parent)
        { when: /key in \("OOL-96"\)/, issues: [issue("OOL-96", "Ready", "acme/x", { parentKey: "OOL-78" })] },
        { when: /key in \("OOL-78"\)/, issues: [issue("OOL-78", "Ready", "acme/x", { parentKey: null })] },
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "OOL-99")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }, { identifier: "OOL-96", mode: "feature" }]);
  });

  it("skips a feature-node parent while any designated child is in flight", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-78", "Ready", "acme/x")),
        children(
          issue("OOL-79", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
          issue("OOL-80", "Implementing", "acme/x", { parentKey: "OOL-78", statusCategory: "indeterminate" }),
        ),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  // AII-609: the dispatch-gate skip log must name the specific non-terminal child so a
  // stuck Jira feature node is as diagnosable as a stuck Linear one.
  it("names the blocking child in the skip log for a feature-node parent with an in-flight child", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-604", "Ready", "acme/x")),
        children(
          issue("OOL-607", "PR Ready", "acme/x", { parentKey: "OOL-604", statusCategory: "done" }),
          issue("OOL-608", "Implementing", "acme/x", { parentKey: "OOL-604", statusCategory: "indeterminate" }),
        ),
        inFlight(),
      ),
    }).install();
    await provider().fetchAIImplementSnapshot();
    expect(logSpy.mock.calls.map((c) => c[0])).toContainEqual(
      expect.stringContaining("Skipping OOL-604: grouping parent waiting on in-flight AI-Implement children: OOL-608"),
    );
    logSpy.mockRestore();
  });

  it("dispatches a feature-node parent once all designated children are terminal, onto its own branch", async () => {
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: adfDoc("Closing work spec.") } };
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(parentWithSpec),
        children(
          issue("OOL-79", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }),
          issue("OOL-80", "", "acme/x", { parentKey: "OOL-78", statusCategory: "done" }), // undesignated but terminal → no gate (AII-349: only active undesignated block)
        ),
        keyIn(), // OOL-78 has no parent
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
  });

  it("treats a child merged via markMerged (custom status Merged, native status not done) as terminal", async () => {
    // markMerged only sets the AI-Implement Status custom field — native status
    // stays untouched. The gating check must accept that as terminal or the
    // feature-node parent would stay blocked forever after a normal merge.
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: adfDoc("Closing work spec.") } };
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(parentWithSpec),
        children(issue("OOL-79", "Merged", "acme/x", { parentKey: "OOL-78", statusCategory: "indeterminate" })),
        keyIn(), // OOL-78 has no parent
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
  });

  it("skips a parent whose children are not yet designated (race guard)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-78", "Ready", "acme/x")),
        children(issue("OOL-79", "", "acme/x", { parentKey: "OOL-78" })),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("fails closed when the children (gating) query errors: candidates are deferred, not dispatched", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })),
        { when: /parent in/, status: 500 },
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    // Can't tell a leaf from a feature-node parent once gating failed → defer everything.
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("fails open when only the ancestor walk errors: candidate dispatches as a leaf targeting base", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-96", "Plan Approved", "acme/x", { parentKey: "OOL-78" })),
        children(), // OOL-96 has no children → leaf
        { when: /^key in/, status: 500 },
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-96")!;
    expect(leaf).toBeDefined();
    expect(leaf.featureBranchChain).toBeUndefined();
  });

  it("finalizes an empty-spec feature-node-ready parent instead of dispatching", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("OOL-78", "Ready", "acme/x")),
        children(issue("OOL-79", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" })),
        keyIn(), // OOL-78 has no parent
        inFlight(),
      ),
    }).install();
    // OOL-78's description is null (blank spec) in the default issue() helper
    const snap = await provider().fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
    expect(snap.parentsToFinalize).toEqual([
      { issueId: "id-OOL-78", identifier: "OOL-78", scopeKey: "m1" },
    ]);
  });

  it("dispatches a non-empty-spec feature-node-ready parent normally (no regression)", async () => {
    const spec = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Do the work" }] },
        { type: "paragraph", content: [{ type: "text", text: "Actual spec here." }] },
      ],
    };
    const parentWithSpec = { ...issue("OOL-78", "Ready", "acme/x"), fields: { ...issue("OOL-78", "Ready", "acme/x").fields, description: spec } };
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(parentWithSpec),
        children(issue("OOL-79", "PR Ready", "acme/x", { parentKey: "OOL-78", statusCategory: "done" })),
        keyIn(),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "OOL-78")!;
    expect(parent).toBeDefined();
    expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    expect(snap.parentsToFinalize).toEqual([]);
  });
});

describe("JiraProvider.fetchAIImplementSnapshot — Epic Link hierarchy (classic projects)", () => {
  beforeEach(() => { clearFieldCache(); });
  afterEach(() => { clearFieldCache(); });

  const EPIC_FIELDS: ReplyInit = {
    json: [
      { id: "customfield_10100", name: "AI-Implement Status", custom: true },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
      { id: "customfield_10014", name: "Epic Link", custom: true },
    ],
  };

  // Issue with an optional native `parent` and an optional classic Epic Link (cf 10014).
  const issue = (
    key: string,
    status: string,
    repo: string,
    extra: { parentKey?: string | null; epicLink?: string | null; statusCategory?: string } = {},
  ): JiraIssue => ({
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

  // No status/repo overrides → the provider lists the fields and resolves the Epic Link field id.
  const provider = () =>
    makeProvider({ cacheScope: "epic-scope", mappings: { m1: jiraMapping({ jql: "project = OOL", repoFieldValue: "acme/x" }) } });

  it("attributes an Epic-Link child to its epic and blocks the epic while that child is in flight", async () => {
    fakeFetch({
      [FIELDS]: EPIC_FIELDS,
      [SEARCH]: jqlSearch(
        ready(issue("OOL-200", "Ready", "acme/x")), // epic, no native parent
        // childrenJql ORs the Epic Link clause; the in-flight child is linked via Epic Link only
        children(issue("OOL-201", "Implementing", "acme/x", { epicLink: "OOL-200", statusCategory: "indeterminate" })),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    // Pre-fix this epic looked like a leaf (epic-link child dropped) and dispatched prematurely.
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("an Epic-Link leaf targets its epic's feature branch", async () => {
    fakeFetch({
      [FIELDS]: EPIC_FIELDS,
      [SEARCH]: jqlSearch(
        ready(issue("OOL-201", "Plan Approved", "acme/x", { epicLink: "OOL-200" })),
        children(), // story has no children → leaf
        keyIn(issue("OOL-200", "Implementing", "acme/x")), // epic is designated
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.readyForImplementation.find((i) => i.identifier === "OOL-201")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-200", mode: "feature" }]);
    expect(leaf.parentRef).toEqual({ identifier: "OOL-200" });
  });

  it("rolls up an Epic-Link feature node (child attributed via Epic Link)", async () => {
    fakeFetch({
      [FIELDS]: EPIC_FIELDS,
      [SEARCH]: jqlSearch(
        completed(issue("OOL-200", "PR Ready", "acme/x", { statusCategory: "done" })),
        children(issue("OOL-201", "PR Ready", "acme/x", { epicLink: "OOL-200", statusCategory: "done" })),
      ),
    }).install();
    const rollUps = await provider().fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-200", identifier: "OOL-200", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-201"] }]);
  });
});

describe("JiraProvider.fetchFeatureNodeRollUps", () => {
  const issue = (key: string, status: string, repo: string, parentKey: string | null = null): JiraIssue => ({
    id: `id-${key}`, key,
    fields: {
      parent: parentKey ? { key: parentKey } : null,
      customfield_10100: status ? { value: status } : null,
      customfield_10101: { value: repo },
    },
  });
  const provider = () =>
    makeProvider({ cacheScope: "c", mappings: { m1: jiraMapping({ jql: "project = OOL", repoFieldValue: "acme/x", ...ALL_OVERRIDES }) } });

  it("rolls a completed feature node into its designated parent (auto-merge → parentIdentifier set)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-90", "PR Ready", "acme/x", "OOL-78")), // completed node w/ parent
        children(issue("OOL-91", "Merged", "acme/x", "OOL-90")),     // designated child, terminal → feature node
        keyIn(issue("OOL-78", "Ready", "acme/x", null)),             // parent is designated
      ),
    }).install();
    const rollUps = await provider().fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-90", identifier: "OOL-90", scopeKey: "m1", mode: "feature", parent: { identifier: "OOL-78", mode: "feature" }, childIdentifiers: ["OOL-91"] }]);
  });

  it("top-of-tree feature node → parentIdentifier null (human feature→base PR)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-78", "PR Ready", "acme/x", null)),
        children(issue("OOL-79", "Merged", "acme/x", "OOL-78")),
      ),
    }).install();
    const rollUps = await provider().fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-78", identifier: "OOL-78", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-79"] }]);
  });

  it("excludes completed issues that are not feature nodes (no designated children)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-1", "PR Ready", "acme/x", null)),
        children(), // no children → not a feature node
      ),
    }).install();
    expect(await provider().fetchFeatureNodeRollUps()).toEqual([]);
  });

  it("excludes a completed issue whose own AI-Implement Status is unset (not a designated node)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-5", "", "acme/x", null)),
        children(issue("OOL-6", "Merged", "acme/x", "OOL-5")),
      ),
    }).install();
    expect(await provider().fetchFeatureNodeRollUps()).toEqual([]);
  });

  it("sets parentIdentifier null when the parent exists but is not itself designated", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-90", "PR Ready", "acme/x", "OOL-70")),
        children(issue("OOL-91", "Merged", "acme/x", "OOL-90")),
        keyIn(issue("OOL-70", "", "acme/x", null)),
      ),
    }).install();
    const rollUps = await provider().fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([{ issueId: "id-OOL-90", identifier: "OOL-90", scopeKey: "m1", mode: "feature", parent: null, childIdentifiers: ["OOL-91"] }]);
  });

  // AII-609: the parent's own status reaching Done is not a proxy for its children's —
  // a designated child still short of a terminal status must defer the roll-up.
  it("defers the roll-up while a designated child is not yet terminal (AII-609)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(issue("OOL-604", "PR Ready", "acme/x", null)),
        children(
          issue("OOL-607", "Merged", "acme/x", "OOL-604"),
          issue("OOL-608", "Implementing", "acme/x", "OOL-604"), // still in flight
        ),
      ),
    }).install();
    expect(await provider().fetchFeatureNodeRollUps()).toEqual([]);
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
  ): JiraIssue => ({
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

  const provider = () =>
    makeProvider({ cacheScope: "c-mode", mappings: { m1: jiraMapping({ jql: "project = BAC", repoFieldValue: "acme/x", ...ALL_OVERRIDES }) } });

  it("reads multi-issue mode from an ADF code block", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })),
        children(),
        keyIn(issue("BAC-1", "Implementing", "acme/x", { description: ADF_MULTI })),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "multi-issue" }]);
  });

  it("reads multi-issue mode from a plain-string description", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })),
        children(),
        keyIn(issue("BAC-1", "Implementing", "acme/x", { description: PLAIN_MULTI })),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "multi-issue" }]);
  });

  it("leaves feature-node behaviour unchanged with no ai-implement.yml", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })),
        children(),
        keyIn(issue("BAC-1", "Implementing", "acme/x")),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const leaf = snap.needsPlanning.find((i) => i.identifier === "BAC-2")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "BAC-1", mode: "feature" }]);
  });

  it("strips the config block from the description handed to the runner", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("BAC-1", "Ready", "acme/x", { description: ADF_MULTI })),
        children(issue("BAC-3", "Merged", "acme/x", { parentKey: "BAC-1", statusCategory: "indeterminate" })),
        keyIn(),
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
    const parent = snap.needsPlanning.find((i) => i.identifier === "BAC-1")!;
    expect(parent.description).toBe("Group of unrelated work.");
    expect(parent.description).not.toContain("feature_branch");
  });

  it("defaults ancestor modes to feature when the ancestor walk fails (fails open)", async () => {
    fakeFetch({
      [SEARCH]: jqlSearch(
        ready(issue("BAC-2", "Ready", "acme/x", { parentKey: "BAC-1" })),
        children(),
        { when: /^key in/, status: 500 },
        inFlight(),
      ),
    }).install();
    const snap = await provider().fetchAIImplementSnapshot();
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
    ): JiraIssue => ({
      id: `id-${key}`,
      key,
      fields: {
        description,
        parent: parentKey ? { key: parentKey } : null,
        customfield_10100: status ? { value: status } : null,
        customfield_10101: { value: repo },
      },
    });

    fakeFetch({
      [SEARCH]: jqlSearch(
        completed(rollupIssue("BAC-1", "PR Ready", "acme/x", null, ADF_MULTI)),
        children(rollupIssue("BAC-2", "Merged", "acme/x", "BAC-1")),
      ),
    }).install();
    const rollUps = await provider().fetchFeatureNodeRollUps();
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
  it("returns the issue when found", async () => {
    fakeFetch({
      [`GET ${API}/issue/PROJ-1` as const]: {
        json: { id: "10001", key: "PROJ-1", fields: { summary: "Hello", description: "World", status: { name: "In Progress" } } },
      },
    }).install();
    const p = makeProvider({ cacheScope: "c-fbk", mappings: {} });
    const issue = await p.findByKey("PROJ-1");
    expect(issue).toEqual({
      id: "10001", identifier: "PROJ-1", title: "Hello", description: "World",
      scopeKey: "", nativeStatus: "In Progress",
    });
  });

  it("returns null on 404", async () => {
    fakeFetch({ [`GET ${API}/issue/MISS-1` as const]: jiraError(404, "Issue does not exist or you do not have permission to see it.") }).install();
    const p = makeProvider({ cacheScope: "c-fbk2", mappings: {} });
    expect(await p.findByKey("MISS-1")).toBeNull();
  });
});

describe("JiraProvider.fetchAIImplementSnapshot — profiles field", () => {
  beforeEach(() => {
    clearFieldCache();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const FIELDS_WITH_PROFILES: ReplyInit = {
    json: [
      selectField("customfield_10100", "AI-Implement Status"),
      selectField("customfield_10101", "AI-Implement Repo"),
      {
        id: "customfield_10200", name: "AI-Implement Profiles", custom: true,
        schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect", customId: 10200 },
      },
    ],
  };

  const profilesIssue = (profiles: unknown): JiraIssue => ({
    id: "10001", key: "P-1",
    fields: {
      summary: "P-1",
      description: null,
      customfield_10100: { value: "Ready" },
      customfield_10101: { value: "acme/x" },
      customfield_10200: profiles,
      issuelinks: [],
      assignee: null,
    },
  });

  it("maps multi-select profile values to issue.profiles", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_WITH_PROFILES,
      [SEARCH]: jqlSearch(ready(profilesIssue([{ value: "backend" }, { value: "webapp" }])), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-prof-multi", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toEqual(["backend", "webapp"]);
  });

  it("leaves profiles absent when the multi-select is empty", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_WITH_PROFILES,
      [SEARCH]: jqlSearch(ready(profilesIssue([])), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-prof-empty", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
  });

  it("leaves profiles absent when the field value is null", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_WITH_PROFILES,
      [SEARCH]: jqlSearch(ready(profilesIssue(null)), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-prof-null", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
  });

  it("leaves profiles absent when the profiles field is not present in Jira (profilesFieldId null)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(
        ready({
          id: "10001", key: "P-1",
          fields: {
            summary: "P-1",
            description: null,
            customfield_10100: { value: "Ready" },
            customfield_10101: { value: "acme/x" },
            issuelinks: [],
            assignee: null,
          },
        }),
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-prof-no-field", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].profiles).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("uses profilesFieldOverride to resolve profiles without calling listFields when all four overrides are set", async () => {
    const fake = fakeFetch({
      [SEARCH]: jqlSearch(
        ready({
          id: "10001", key: "P-1",
          fields: {
            summary: "P-1",
            description: null,
            customfield_10100: { value: "Ready" },
            customfield_10101: { value: "acme/x" },
            customfield_10200: [{ value: "mobile" }],
            issuelinks: [],
            assignee: null,
          },
        }),
        children(),
        inFlight(),
      ),
    }).install();

    const p = makeProvider({ cacheScope: "c-prof-override", mappings: { "acme/x": jiraMapping(ALL_OVERRIDES) } });
    const snap = await p.fetchAIImplementSnapshot();
    // 3 requests total: bucket search + children query + capacity search (no listFields call)
    expect(fake.calls).toHaveLength(3);
    expect(snap.needsPlanning[0].profiles).toEqual(["mobile"]);
  });
});

describe("JiraProvider.fetchAIImplementSnapshot — assignee field", () => {
  beforeEach(() => {
    clearFieldCache();
  });

  const assigneeIssue = (assignee: unknown): JiraIssue => ({
    id: "10001", key: "P-1",
    fields: {
      summary: "P-1",
      description: null,
      customfield_10100: { value: "Ready" },
      customfield_10101: { value: "acme/x" },
      issuelinks: [],
      assignee,
    },
  });

  it("maps the assignee displayName to issue.assigneeName", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(ready(assigneeIssue({ displayName: "Paz" })), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-assignee", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].assigneeName).toBe("Paz");
  });

  it("leaves assigneeName absent when the issue is unassigned", async () => {
    fakeFetch({
      [FIELDS]: FIELDS_REPLY,
      [SEARCH]: jqlSearch(ready(assigneeIssue(null)), children(), inFlight()),
    }).install();

    const p = makeProvider({ cacheScope: "c-assignee-null", mappings: { "acme/x": jiraMapping() } });
    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning[0].assigneeName).toBeUndefined();
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

describe("JiraProvider.listIssuesPage", () => {
  beforeEach(() => {
    clearFieldCache();
    // A request no test routes fails it, even when the provider catches the error.
    fakeFetch({}).install();
  });

  const FIELDS_WITH_EPIC: ReplyInit = {
    json: [
      { id: "customfield_10100", name: "AI-Implement Status", custom: true, schema: {} },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true, schema: {} },
      { id: "customfield_10014", name: "Epic Link", custom: true, schema: {} },
    ],
  };

  const page = (issues: unknown[], nextPageToken?: string): ReplyInit => ({ json: { issues, nextPageToken } });
  /** The field list, then one search reply per page in order, plus any route a test adds. */
  const jira = (pages: ReplyInit[], extra: Routes = {}) =>
    fakeFetch({ [FIELDS]: FIELDS_WITH_EPIC, [SEARCH]: pages, ...extra }).install();
  const mapping = (): RepoMapping => ({ ...jiraMapping(), teamKey: "acme/x" });
  const provider = (scope: string) =>
    makeProvider({ cacheScope: scope, mappings: { "acme/x": jiraMapping() } });

  const full = {
    id: "10001",
    key: "P-1",
    fields: {
      summary: "Full issue",
      description: adfDoc("Body text"),
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      labels: ["a", "b"],
      project: { name: "Proj" },
      parent: { key: "P-0" },
      customfield_10101: { value: "acme/x" },
      issuelinks: [
        { type: { name: "Blocks" }, outwardIssue: { key: "P-2" } },
        { type: { name: "Duplicate" }, outwardIssue: { key: "P-3" } },
        { type: { name: "Relates" }, outwardIssue: { key: "P-4" } },
        { type: { name: "Blocks" }, inwardIssue: { key: "P-5" } },
      ],
      comment: {
        total: 1,
        comments: [{ id: "c1", body: adfDoc("A comment"), created: "2026-01-02T00:00:00.000Z", author: { displayName: "Ada" } }],
      },
    },
  };

  it("maps an issue to the tracker record shape and omits branchName, sourceSystem and team", async () => {
    const fake = jira([page([full])]);
    const res = await provider("lip-map").listIssuesPage(mapping(), null);

    expect(res.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    const rec = res.issues[0];
    expect(rec).toEqual({
      id: "10001",
      identifier: "P-1",
      title: "Full issue",
      description: "Body text",
      state: { name: "In Progress", type: "indeterminate" },
      labels: { nodes: [{ name: "a" }, { name: "b" }] },
      project: { name: "Proj" },
      parent: { identifier: "P-0" },
      comments: { nodes: [{ body: "A comment", user: { name: "Ada" }, createdAt: "2026-01-02T00:00:00.000Z" }] },
      relations: {
        nodes: [
          { type: "blocks", relatedIssue: { identifier: "P-2" } },
          { type: "duplicate", relatedIssue: { identifier: "P-3" } },
          { type: "related", relatedIssue: { identifier: "P-4" } },
          { type: "related", relatedIssue: { identifier: "P-5" } },
        ],
      },
    });
    const body = JSON.parse(fake.calls[1].body);
    expect(body.jql).toBe("(project = P)");
    expect(body.fields).toEqual(expect.arrayContaining(["comment", "issuelinks", "customfield_10101", "customfield_10014"]));
  });

  it("takes the parent from Epic Link when there is no native parent", async () => {
    const epicChild = { id: "2", key: "P-6", fields: { summary: "c", customfield_10101: "acme/x", customfield_10014: "P-EPIC" } };
    jira([page([epicChild])]);
    const res = await provider("lip-epic").listIssuesPage(mapping(), null);
    expect(res.issues[0].parent).toEqual({ identifier: "P-EPIC" });
  });

  it("yields nulls and empty arrays for a sparse issue", async () => {
    const sparse = { id: "3", key: "P-7", fields: { summary: "s", customfield_10101: { value: "acme/x" }, comment: null } };
    jira([page([sparse])]);
    const rec = (await provider("lip-sparse").listIssuesPage(mapping(), null)).issues[0];
    expect(rec).toMatchObject({
      description: null, state: null, project: null, parent: null,
      labels: { nodes: [] }, comments: { nodes: [] }, relations: { nodes: [] },
    });
  });

  it("drops an issue whose repo field is another repo, for option and plain-string fields", async () => {
    const other = { id: "4", key: "P-8", fields: { summary: "o", customfield_10101: { value: "acme/other" } } };
    const otherText = { id: "5", key: "P-9", fields: { summary: "o", customfield_10101: "acme/other" } };
    const textMatch = { id: "6", key: "P-10", fields: { summary: "t", customfield_10101: "acme/x" } };
    jira([page([other, otherText, textMatch])]);
    const res = await provider("lip-drop").listIssuesPage(mapping(), null);
    expect(res.issues.map((i) => i.identifier)).toEqual(["P-10"]);
  });

  it("chains two pages through the cursor", async () => {
    const a = { id: "7", key: "P-11", fields: { summary: "a", customfield_10101: "acme/x" } };
    const b = { id: "8", key: "P-12", fields: { summary: "b", customfield_10101: "acme/x" } };
    const fake = jira([page([a], "tok-2"), page([b])]);
    const p = provider("lip-chain");
    const first = await p.listIssuesPage(mapping(), null);
    expect(first.pageInfo).toEqual({ hasNextPage: true, endCursor: "tok-2" });
    const second = await p.listIssuesPage(mapping(), first.pageInfo.endCursor);
    expect(second.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect(second.issues.map((i) => i.identifier)).toEqual(["P-12"]);
    expect(JSON.parse(fake.calls[1].body)).not.toHaveProperty("nextPageToken");
    expect(JSON.parse(fake.calls[2].body).nextPageToken).toBe("tok-2");
  });

  it("completes a truncated embedded comment list with listComments, capped at 100", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: `c${i}`, body: adfDoc(`n${i}`), created: "2026-01-01T00:00:00.000Z", author: null,
    }));
    const trunc = {
      id: "9", key: "P-13",
      fields: { summary: "t", customfield_10101: "acme/x", comment: { total: 150, comments: many.slice(0, 20) } },
    };
    jira([page([trunc])], {
      [`GET ${API}/issue/P-13/comment`]: [
        { json: { comments: many.slice(0, 100), total: 150 } },
        { json: { comments: many.slice(100), total: 150 } },
      ],
    });
    const rec = (await provider("lip-trunc").listIssuesPage(mapping(), null)).issues[0];
    expect(rec.comments.nodes).toHaveLength(100);
    expect(rec.comments.nodes[0]).toEqual({ body: "n0", user: null, createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("keeps the newest 100 of 101 embedded comments, newest first, without listComments", async () => {
    const embedded = Array.from({ length: 101 }, (_, i) => ({
      id: `c${i}`, body: adfDoc(`n${i}`), created: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), author: null,
    }));
    const full = {
      id: "10", key: "P-14",
      fields: { summary: "t", customfield_10101: "acme/x", comment: { total: 101, comments: embedded } },
    };
    const fake = jira([page([full])]);
    const rec = (await provider("lip-101").listIssuesPage(mapping(), null)).issues[0];
    expect(fake.calls).toHaveLength(2);
    expect(rec.comments.nodes).toHaveLength(100);
    expect(rec.comments.nodes[0].body).toBe("n100");
    expect(rec.comments.nodes.map((c) => c.body)).not.toContain("n0");
  });

  it("throws TrackerUnavailableError for a mapping without Jira config or team key", async () => {
    const p = provider("lip-unavail");
    await expect(p.listIssuesPage({ ...jiraMapping(), teamKey: undefined }, null)).rejects.toBeInstanceOf(TrackerUnavailableError);
    await expect(
      p.listIssuesPage(makeMapping({ teamKey: "X" }), null),
    ).rejects.toBeInstanceOf(TrackerUnavailableError);
  });

  it("propagates a Jira API error so Restate retries it", async () => {
    jira([jiraError(500, "boom")]);
    await expect(provider("lip-err").listIssuesPage(mapping(), null)).rejects.toBeInstanceOf(JiraApiError);
  });
});
