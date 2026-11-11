import { defaultFetchSignal } from "../github.js";

export interface JiraClientConfig {
  /** API token (used with Basic auth) or OAuth 2.0 access token (Bearer). */
  token: string;
  /**
   * Service-account email. When set, the client authenticates with Basic auth
   * (email:token) against `siteUrl`, with an API token from id.atlassian.com,
   * which Atlassian caps at a year. When unset, it falls back to Bearer auth
   * through the OAuth gateway (api.atlassian.com), which requires `cloudId`.
   */
  email?: string;
  /** Site base URL (https://<site>.atlassian.net). Required for Basic auth. */
  siteUrl?: string;
  /** Cloud ID for the OAuth gateway path (Bearer). Required when email is unset. */
  cloudId?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  body: unknown; // ADF JSON
  created?: string; // ISO 8601 timestamp
  author?: { displayName?: string } | null;
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
}

export class JiraApiError extends Error {
  constructor(public readonly status: number, public readonly bodyText: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "JiraApiError";
  }
}

export class JiraFieldNotSelectError extends Error {
  constructor(public readonly fieldId: string) {
    super(`Field ${fieldId} is not a select / has no option list`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "JiraFieldNotSelectError";
  }
}

const SEARCH_PAGE_SIZE = 100;

export class JiraClient {
  private readonly apiBase: string;
  private readonly authHeader: string;

  constructor(config: JiraClientConfig) {
    if (config.email) {
      // Basic auth (email:api-token) against the site domain. Long-lived; no
      // token refresh needed. Same REST v3 paths as the OAuth gateway.
      if (!config.siteUrl) {
        throw new Error("JiraClient: siteUrl is required for Basic auth (email set)");
      }
      this.apiBase = config.siteUrl.replace(/\/+$/, "");
      const basic = Buffer.from(`${config.email}:${config.token}`).toString("base64");
      this.authHeader = `Basic ${basic}`;
    } else {
      // OAuth 2.0 gateway path (Bearer). Access tokens are short-lived.
      if (!config.cloudId) {
        throw new Error("JiraClient: cloudId is required for Bearer auth (email unset)");
      }
      const cloudId = config.cloudId.replace(/\/$/, "");
      this.apiBase = `https://api.atlassian.com/ex/jira/${cloudId}`;
      this.authHeader = `Bearer ${config.token}`;
    }
  }

  private async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: defaultFetchSignal(),
      });
    } catch (err) {
      // Node/undici throws a generic "fetch failed" TypeError for anything below
      // the HTTP layer (DNS, TLS, connection refused, timeout) — the actual reason
      // lives in `err.cause`, which is otherwise silently dropped by callers that
      // only read `err.message`. Fold it into the message and log server-side so
      // it survives round-tripping through the admin API as a JSON error string.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      const detail = cause ?? (err instanceof Error ? err.message : String(err));
      console.error(`[jira-client] ${method} ${url} network error: ${detail}`);
      throw new Error(`Jira ${method} ${path} failed before receiving a response: ${detail}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new JiraApiError(
        res.status,
        text,
        `Jira ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    return res;
  }

  /** For endpoints whose response body the caller does NOT read. Tolerates 204. */
  private async request(method: string, path: string, body?: unknown): Promise<void> {
    await this.rawRequest(method, path, body);
  }

  /**
   * For endpoints whose response body the caller WILL read. Throws on 204 with
   * a clear error rather than returning undefined (which would crash on the next
   * property access).
   */
  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.rawRequest(method, path, body);
    if (res.status === 204) {
      throw new JiraApiError(
        res.status,
        "",
        `Jira ${method} ${path} returned 204 No Content; expected JSON body`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Run a JQL search via POST /rest/api/3/search/jql (the modern endpoint;
   * GET /search is deprecated). Pages with nextPageToken. Caps at MAX_PAGES.
   */
  async searchJql(jql: string, fields: string[]): Promise<JiraIssue[]> {
    const PAGE_SIZE = SEARCH_PAGE_SIZE;
    const MAX_PAGES = 20;
    const all: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let page = 0;

    do {
      const body: Record<string, unknown> = { jql, fields, maxResults: PAGE_SIZE };
      if (nextPageToken !== undefined) body.nextPageToken = nextPageToken;
      const res = await this.requestJson<{ issues: JiraIssue[]; nextPageToken?: string }>(
        "POST", "/rest/api/3/search/jql", body,
      );
      all.push(...res.issues);
      nextPageToken = res.nextPageToken;
      if (++page >= MAX_PAGES) {
        console.warn(`[jira-client] hit MAX_PAGES (${MAX_PAGES}), ${all.length} issues fetched`);
        break;
      }
    } while (nextPageToken);

    return all;
  }

  /**
   * One page of POST /rest/api/3/search/jql. The caller owns the loop: pass the
   * previous page's `nextPageToken` (omit for the first page); an absent token in
   * the result means the last page. Same request body as `searchJql`.
   */
  async searchJqlPage(
    jql: string,
    fields: string[],
    nextPageToken?: string,
    maxResults = SEARCH_PAGE_SIZE,
  ): Promise<{ issues: JiraIssue[]; nextPageToken?: string }> {
    const body: Record<string, unknown> = { jql, fields, maxResults };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await this.requestJson<{ issues?: JiraIssue[]; nextPageToken?: string }>(
      "POST", "/rest/api/3/search/jql", body,
    );
    return { issues: res.issues ?? [], nextPageToken: res.nextPageToken || undefined };
  }

  /**
   * Validate JQL without executing it via /rest/api/3/jql/parse. Jira answers 200 even for a
   * rejected query and reports the problem in `queries[].errors` (syntax errors, unknown fields,
   * a dropdown value with no matching option), so the body must be read, not just the status.
   */
  async validateJql(jql: string): Promise<{ valid: true } | { valid: false; errors: string[] }> {
    try {
      const res = await this.requestJson<{ queries?: Array<{ errors?: string[] }> }>(
        "POST", "/rest/api/3/jql/parse", { queries: [jql] },
      );
      const errors = res.queries?.[0]?.errors ?? [];
      return errors.length > 0 ? { valid: false, errors } : { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [message] };
    }
  }

  async listCreateIssueTypes(projectId: string): Promise<Array<{ id: string; subtask: boolean; hierarchyLevel?: number }>> {
    type IssueType = { id: string; subtask: boolean; hierarchyLevel?: number };
    const types: IssueType[] = [];
    for (;;) {
      const page = await this.requestJson<{ issueTypes?: IssueType[]; values?: IssueType[]; total?: number; isLast?: boolean }>(
        "GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes?startAt=${types.length}&maxResults=100`,
      );
      const batch = page.issueTypes ?? page.values ?? [];
      types.push(...batch);
      if (!batch.length || page.isLast === true || (page.total !== undefined ? types.length >= page.total : page.isLast !== false)) return types;
    }
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.requestJson("POST", "/rest/api/3/issue", { fields });
  }

  async setField(issueKey: string, fieldId: string, value: unknown): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { [fieldId]: value },
    });
  }

  async getIssue(issueKey: string, fields: string[]): Promise<JiraIssue> {
    const params = new URLSearchParams({ fields: fields.join(",") });
    return this.requestJson<JiraIssue>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params}`,
    );
  }

  async addComment(issueKey: string, adfBody: unknown): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: adfBody,
    });
  }

  async listComments(issueKey: string): Promise<JiraComment[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 3;
    const all: JiraComment[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        startAt: String(all.length),
        maxResults: String(PAGE_SIZE),
        orderBy: "-created",
      });
      const data = await this.requestJson<{ comments: JiraComment[]; total: number }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${params}`,
      );
      const batch = data.comments ?? [];
      all.push(...batch);
      if (all.length >= (data.total ?? 0) || batch.length === 0) break;
    }

    return all;
  }

  /**
   * Proves the credentials with the cheapest call any account that can use Jira may make, needing only the
   * `read:jira-work` scope the poll needs. Most reads answer a wrong or missing credential as an anonymous
   * caller instead of refusing it, and this one refuses with 401.
   */
  async verifyCredentials(): Promise<void> {
    await this.requestJson("GET", "/rest/api/3/resolution/search?maxResults=1");
  }

  async listFields(): Promise<JiraField[]> {
    return this.requestJson<JiraField[]>("GET", "/rest/api/3/field");
  }

  /**
   * Returns the merged option list for a select-type custom field, every page of contexts and of options.
   * Throws JiraFieldNotSelectError if the field has no contexts (typically
   * means it is not a select / multi-select).
   */
  async getFieldOptions(fieldId: string): Promise<Array<{ id: string; value: string }>> {
    const id = encodeURIComponent(fieldId);

    let contexts: Array<{ id: string }>;
    try {
      contexts = await this.allPages<{ id: string }>(`/rest/api/3/field/${id}/context`);
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 404) {
        throw new JiraFieldNotSelectError(fieldId);
      }
      throw err;
    }

    const merged = new Map<string, { id: string; value: string }>();
    for (const ctx of contexts) {
      const options = await this.allPages<{ id: string; value: string }>(
        `/rest/api/3/field/${id}/context/${encodeURIComponent(ctx.id)}/option`,
      );
      for (const opt of options) {
        if (!merged.has(opt.id)) merged.set(opt.id, opt);
      }
    }
    return Array.from(merged.values());
  }

  /** Every page of a `startAt`-paged list. A page without `isLast` is taken as the last. */
  private async allPages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (;;) {
      // The first page needs no offset, since startAt defaults to 0.
      const page = await this.requestJson<{ values: T[]; isLast?: boolean }>("GET", all.length === 0 ? path : `${path}?startAt=${all.length}`);
      all.push(...page.values);
      if (page.isLast !== false || page.values.length === 0) return all;
    }
  }
}
