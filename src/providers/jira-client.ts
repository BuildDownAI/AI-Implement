export interface JiraClientConfig {
  /** API token (used with Basic auth) or OAuth 2.0 access token (Bearer). */
  token: string;
  /**
   * Service-account email. When set, the client authenticates with Basic auth
   * (email:token) against `siteUrl` — the durable API-token path for Jira
   * Cloud (tokens from id.atlassian.com don't expire). When unset, it falls
   * back to Bearer auth through the OAuth gateway (api.atlassian.com), which
   * requires `cloudId`.
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
    const PAGE_SIZE = 100;
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

  /** Validate JQL without executing it via /rest/api/3/jql/parse. */
  async validateJql(jql: string): Promise<{ valid: true } | { valid: false; errors: string[] }> {
    try {
      await this.request("POST", "/rest/api/3/jql/parse", { queries: [jql] });
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [message] };
    }
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
    const data = await this.requestJson<{ comments: JiraComment[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    );
    return data.comments ?? [];
  }

  async listFields(): Promise<JiraField[]> {
    return this.requestJson<JiraField[]>("GET", "/rest/api/3/field");
  }

  /**
   * Returns the merged option list for a select-type custom field.
   * Throws JiraFieldNotSelectError if the field has no contexts (typically
   * means it is not a select / multi-select).
   *
   * Note: reads only the first page of contexts and the first page of options
   * per context. Jira's default page size is 100, which is far above any
   * realistic AI-Implement Repo or Status field. If a field exceeds that, the
   * returned list will be silently truncated — add pagination if that becomes
   * a real-world concern.
   */
  async getFieldOptions(fieldId: string): Promise<Array<{ id: string; value: string }>> {
    const id = encodeURIComponent(fieldId);

    let contexts: Array<{ id: string }>;
    try {
      const res = await this.requestJson<{ values: Array<{ id: string }> }>(
        "GET",
        `/rest/api/3/field/${id}/context`,
      );
      contexts = res.values;
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 404) {
        throw new JiraFieldNotSelectError(fieldId);
      }
      throw err;
    }

    const merged = new Map<string, { id: string; value: string }>();
    for (const ctx of contexts) {
      const ctxId = encodeURIComponent(ctx.id);
      const optRes = await this.requestJson<{ values: Array<{ id: string; value: string }> }>(
        "GET",
        `/rest/api/3/field/${id}/context/${ctxId}/option`,
      );
      for (const opt of optRes.values) {
        if (!merged.has(opt.id)) merged.set(opt.id, opt);
      }
    }
    return Array.from(merged.values());
  }
}
