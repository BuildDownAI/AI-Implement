import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraClient } from "../../providers/jira-client.js";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as any;
});

describe("JiraClient", () => {
  const config = { token: "tok", cloudId: "CLOUD-123" };
  const expectedAuth = "Bearer tok";

  it("attaches Bearer auth header from token", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ issues: [] }),
    });
    const client = new JiraClient(config);
    await client.searchJql("project = X", []);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(expectedAuth);
  });

  it("routes API calls through api.atlassian.com with the cloud ID", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ issues: [] }) });
    const client = new JiraClient({ token: "tok", cloudId: "CLOUD-123" });
    await client.searchJql("project = X", []);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/search/jql");
  });

  it("searchJql posts to /rest/api/3/search/jql with paginated body", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ issues: [{ id: "1", key: "X-1", fields: {} }] }),
    });
    const client = new JiraClient(config);
    const issues = await client.searchJql("project = X", ["summary"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("X-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/search/jql");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.jql).toBe("project = X");
    expect(body.fields).toEqual(["summary"]);
    expect(body.maxResults).toBeGreaterThan(0);
  });

  it("searchJql follows nextPageToken until exhausted", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ issues: [{ id: "1", key: "X-1", fields: {} }], nextPageToken: "p2" }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ issues: [{ id: "2", key: "X-2", fields: {} }] }),
      });
    const client = new JiraClient(config);
    const issues = await client.searchJql("project = X", []);
    expect(issues.map((i) => i.key)).toEqual(["X-1", "X-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).nextPageToken).toBe("p2");
  });

  it("validateJql returns valid:true on success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const client = new JiraClient(config);
    expect(await client.validateJql("project = X")).toEqual({ valid: true });
  });

  it("validateJql returns valid:false with error on failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400, statusText: "Bad Request",
      text: async () => '{"errors": ["bad jql"]}',
    });
    const client = new JiraClient(config);
    const result = await client.validateJql("garbage =");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("setField PUTs to /rest/api/3/issue/{key} with the field in the body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    const client = new JiraClient(config);
    await client.setField("PROJ-1", "customfield_10042", { value: "Planning" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      fields: { customfield_10042: { value: "Planning" } },
    });
  });

  it("URL-encodes issue keys with special chars", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    const client = new JiraClient(config);
    await client.setField("PROJ/1", "customfield_10042", { value: "x" });
    expect(fetchMock.mock.calls[0][0]).toContain("PROJ%2F1");
  });

  it("addComment posts ADF body to comment endpoint", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "c1" }) });
    const client = new JiraClient(config);
    const adf = { type: "doc", version: 1, content: [] };
    await client.addComment("PROJ-1", adf);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/issue/PROJ-1/comment");
    expect(JSON.parse(init.body)).toEqual({ body: adf });
  });

  it("listFields GETs /rest/api/3/field", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => [{ id: "customfield_1", name: "X", custom: true }],
    });
    const client = new JiraClient(config);
    const fields = await client.listFields();
    expect(fields).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.atlassian.com/ex/jira/CLOUD-123/rest/api/3/field");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("getIssue requests specified fields via query param", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: "1", key: "X-1", fields: {} }),
    });
    const client = new JiraClient(config);
    await client.getIssue("X-1", ["summary", "customfield_10042"]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/rest/api/3/issue/X-1");
    expect(url).toContain("fields=summary%2Ccustomfield_10042");
  });

  it("throws on non-OK response with message including status and body excerpt", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 500, statusText: "Internal Server Error",
      text: async () => "Server died",
    });
    const client = new JiraClient(config);
    await expect(client.searchJql("project = X", [])).rejects.toThrow(/500/);
  });

  it("tolerates 204 on body-less endpoints (setField, addComment)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const client = new JiraClient(config);
    await expect(client.setField("ENG-1", "customfield_1", { value: "x" })).resolves.toBeUndefined();
    await expect(client.addComment("ENG-1", { version: 1, type: "doc", content: [] })).resolves.toBeUndefined();
  });

  it("throws a clear error if a body-expecting endpoint returns 204", async () => {
    // searchJql expects JSON; a 204 here would have crashed dereferencing res.issues.
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const client = new JiraClient(config);
    await expect(client.searchJql("project = X", [])).rejects.toThrow(/204 No Content/);
  });

  it("throws on 204 from getIssue", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const client = new JiraClient(config);
    await expect(client.getIssue("ENG-1", ["summary"])).rejects.toThrow(/204 No Content/);
  });

  it("throws on 204 from listFields", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const client = new JiraClient(config);
    await expect(client.listFields()).rejects.toThrow(/204 No Content/);
  });
});
