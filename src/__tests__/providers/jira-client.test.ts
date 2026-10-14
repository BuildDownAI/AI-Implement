import { describe, it, expect } from "vitest";
import { JiraClient } from "../../providers/jira-client.js";
import { fakeFetch } from "../helpers/fake-fetch.js";

// The OAuth gateway's REST base for the Bearer config below.
const GATEWAY = "/ex/jira/CLOUD-123/rest/api/3";

describe("JiraClient", () => {
  const config = { token: "tok", cloudId: "CLOUD-123" };
  const expectedAuth = "Bearer tok";

  it("attaches Bearer auth header from token", async () => {
    const fake = fakeFetch({ [`POST ${GATEWAY}/search/jql`]: { json: { issues: [] } } }).install();
    const client = new JiraClient(config);
    await client.searchJql("project = X", []);
    expect(fake.calls[0].headers.get("authorization")).toBe(expectedAuth);
  });

  it("routes API calls through api.atlassian.com with the cloud ID", async () => {
    const fake = fakeFetch({ [`POST ${GATEWAY}/search/jql`]: { json: { issues: [] } } }).install();
    const client = new JiraClient({ token: "tok", cloudId: "CLOUD-123" });
    await client.searchJql("project = X", []);
    expect(fake.calls[0].url.href).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/search/jql");
  });

  it("searchJql posts to /rest/api/3/search/jql with paginated body", async () => {
    const fake = fakeFetch({
      [`POST ${GATEWAY}/search/jql`]: { json: { issues: [{ id: "1", key: "X-1", fields: {} }] } },
    }).install();
    const client = new JiraClient(config);
    const issues = await client.searchJql("project = X", ["summary"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("X-1");
    const [call] = fake.calls;
    expect(call.url.href).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/search/jql");
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body);
    expect(body.jql).toBe("project = X");
    expect(body.fields).toEqual(["summary"]);
    expect(body.maxResults).toBeGreaterThan(0);
  });

  it("searchJql follows nextPageToken until exhausted", async () => {
    const fake = fakeFetch({
      [`POST ${GATEWAY}/search/jql`]: [
        { json: { issues: [{ id: "1", key: "X-1", fields: {} }], nextPageToken: "p2" } },
        { json: { issues: [{ id: "2", key: "X-2", fields: {} }] } },
      ],
    }).install();
    const client = new JiraClient(config);
    const issues = await client.searchJql("project = X", []);
    expect(issues.map((i) => i.key)).toEqual(["X-1", "X-2"]);
    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(fake.calls[1].body).nextPageToken).toBe("p2");
  });

  it("validateJql returns valid:true on success", async () => {
    fakeFetch({ [`POST ${GATEWAY}/jql/parse`]: { json: {} } }).install();
    const client = new JiraClient(config);
    expect(await client.validateJql("project = X")).toEqual({ valid: true });
  });

  it("validateJql returns valid:false with error on failure", async () => {
    fakeFetch({ [`POST ${GATEWAY}/jql/parse`]: { status: 400, text: '{"errors": ["bad jql"]}' } }).install();
    const client = new JiraClient(config);
    const result = await client.validateJql("garbage =");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("setField PUTs to /rest/api/3/issue/{key} with the field in the body", async () => {
    const fake = fakeFetch({ [`PUT ${GATEWAY}/issue/PROJ-1`]: { status: 204 } }).install();
    const client = new JiraClient(config);
    await client.setField("PROJ-1", "customfield_10042", { value: "Planning" });
    const [call] = fake.calls;
    expect(call.url.href).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/issue/PROJ-1");
    expect(call.method).toBe("PUT");
    expect(JSON.parse(call.body)).toEqual({
      fields: { customfield_10042: { value: "Planning" } },
    });
  });

  it("URL-encodes issue keys with special chars", async () => {
    // A route key matches the request's path as sent, so the encoded key stays encoded.
    const fake = fakeFetch({ [`PUT ${GATEWAY}/issue/PROJ%2F1`]: { status: 204 } }).install();
    const client = new JiraClient(config);
    await client.setField("PROJ/1", "customfield_10042", { value: "x" });
    expect(fake.calls[0].url.href).toContain("PROJ%2F1");
  });

  it("addComment posts ADF body to comment endpoint", async () => {
    const fake = fakeFetch({ [`POST ${GATEWAY}/issue/PROJ-1/comment`]: { status: 201, json: { id: "c1" } } }).install();
    const client = new JiraClient(config);
    const adf = { type: "doc", version: 1, content: [] };
    await client.addComment("PROJ-1", adf);
    const [call] = fake.calls;
    expect(call.url.href).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/issue/PROJ-1/comment");
    expect(JSON.parse(call.body)).toEqual({ body: adf });
  });

  it("listFields GETs /rest/api/3/field", async () => {
    const fake = fakeFetch({ [`GET ${GATEWAY}/field`]: { json: [{ id: "customfield_1", name: "X", custom: true }] } }).install();
    const client = new JiraClient(config);
    const fields = await client.listFields();
    expect(fields).toHaveLength(1);
    expect(fake.calls[0].url.href).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/field");
    expect(fake.calls[0].method).toBe("GET");
  });

  it("getIssue requests specified fields via query param", async () => {
    const fake = fakeFetch({ [`GET ${GATEWAY}/issue/X-1`]: { json: { id: "1", key: "X-1", fields: {} } } }).install();
    const client = new JiraClient(config);
    await client.getIssue("X-1", ["summary", "customfield_10042"]);
    const url = fake.calls[0].url.href;
    expect(url).toContain("/rest/api/3/issue/X-1");
    expect(url).toContain("fields=summary%2Ccustomfield_10042");
  });

  it("throws on non-OK response with message including status and body excerpt", async () => {
    fakeFetch({ [`POST ${GATEWAY}/search/jql`]: { status: 500, text: "Server died" } }).install();
    const client = new JiraClient(config);
    await expect(client.searchJql("project = X", [])).rejects.toThrow(/500/);
  });

  it("tolerates 204 on body-less endpoints (setField, addComment)", async () => {
    fakeFetch({
      [`PUT ${GATEWAY}/issue/ENG-1`]: { status: 204 },
      [`POST ${GATEWAY}/issue/ENG-1/comment`]: { status: 204 },
    }).install();
    const client = new JiraClient(config);
    await expect(client.setField("ENG-1", "customfield_1", { value: "x" })).resolves.toBeUndefined();
    await expect(client.addComment("ENG-1", { version: 1, type: "doc", content: [] })).resolves.toBeUndefined();
  });

  it("throws a clear error if a body-expecting endpoint returns 204", async () => {
    // searchJql expects JSON; a 204 here would have crashed dereferencing res.issues.
    fakeFetch({ [`POST ${GATEWAY}/search/jql`]: { status: 204 } }).install();
    const client = new JiraClient(config);
    await expect(client.searchJql("project = X", [])).rejects.toThrow(/204 No Content/);
  });

  it("throws on 204 from getIssue", async () => {
    fakeFetch({ [`GET ${GATEWAY}/issue/ENG-1`]: { status: 204 } }).install();
    const client = new JiraClient(config);
    await expect(client.getIssue("ENG-1", ["summary"])).rejects.toThrow(/204 No Content/);
  });

  it("throws on 204 from listFields", async () => {
    fakeFetch({ [`GET ${GATEWAY}/field`]: { status: 204 } }).install();
    const client = new JiraClient(config);
    await expect(client.listFields()).rejects.toThrow(/204 No Content/);
  });
});

describe("JiraClient Basic auth (email + API token)", () => {
  const basicConfig = {
    token: "api-tok",
    email: "svc@example.com",
    siteUrl: "https://acme.atlassian.net",
  };
  const expectedBasic = `Basic ${Buffer.from("svc@example.com:api-tok").toString("base64")}`;

  it("uses Basic auth header when email is set", async () => {
    const fake = fakeFetch({ "POST /rest/api/3/search/jql": { json: { issues: [] } } }).install();
    const client = new JiraClient(basicConfig);
    await client.searchJql("project = X", []);
    expect(fake.calls[0].headers.get("authorization")).toBe(expectedBasic);
  });

  it("routes calls to the site URL (not api.atlassian.com) in Basic mode", async () => {
    const fake = fakeFetch({ "POST /rest/api/3/search/jql": { json: { issues: [] } } }).install();
    const client = new JiraClient({ ...basicConfig, siteUrl: "https://acme.atlassian.net/" });
    await client.searchJql("project = X", []);
    expect(fake.calls[0].url.href).toBe("https://acme.atlassian.net/rest/api/3/search/jql");
  });

  it("throws if email is set without a siteUrl", () => {
    expect(() => new JiraClient({ token: "t", email: "svc@example.com" })).toThrow(/siteUrl/);
  });

  it("throws if neither email nor cloudId is provided", () => {
    expect(() => new JiraClient({ token: "t" })).toThrow(/cloudId/);
  });
});
