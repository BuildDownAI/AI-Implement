import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoMapping } from "../config.js";
import { syncWorkflowTemplates, classifySyncError } from "../workflow-sync.js";
import { GitHubApiError } from "../github-errors.js";

const mapping: RepoMapping = {
  owner: "acme",
  repo: "app",
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
  ticketingProvider: "linear",
  ticketingConfig: { kind: "linear" },
  awsRegion: null,
  paused: false,
  maxTurns: null,
  maxIterations: null,
  maxJobMinutes: null,
  branchPrefix: null,
};

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function makeTemplatesRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "workflow-sync-"));
  mkdirSync(join(tempRoot, "workflows"), { recursive: true });
  writeFileSync(join(tempRoot, "workflows/claude-implement.yml"), "implement-yml\n");
  writeFileSync(join(tempRoot, "workflows/claude-plan.yml"), "plan-yml\n");
  writeFileSync(join(tempRoot, "workflows/WORKFLOW.md"), "workflow-md\n");
  writeFileSync(join(tempRoot, "workflows/PLANNING.md"), "planning-md\n");
  return tempRoot;
}

interface FakePull {
  number: number;
  html_url: string;
  head: string;
  base: { ref: string };
}

function fileSha(content: string): string {
  return `sha-${Buffer.from(content).toString("base64url")}`;
}

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body ?? {}),
  } as Response;
}

function makeGithubFetch(opts?: {
  mainFiles?: Record<string, string>;
  syncFiles?: Record<string, string>;
  syncAheadBy?: number;
  existingPr?: FakePull | null;
}) {
  const branches: Record<string, { sha: string; aheadBy: number; files: Record<string, string> }> = {
    main: { sha: "base-sha", aheadBy: 0, files: { ...(opts?.mainFiles ?? {}) } },
  };
  if (opts?.syncFiles) {
    branches["sync/ai-implement"] = {
      sha: "sync-sha",
      aheadBy: opts.syncAheadBy ?? 0,
      files: { ...opts.syncFiles },
    };
  }
  const pulls: FakePull[] = opts?.existingPr ? [opts.existingPr] : [];
  const calls: Array<{ path: string; method: string; headers: HeadersInit | undefined; body: unknown }> = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, method, headers: init?.headers, body });

    if (method === "GET" && path === "/repos/acme/app") {
      return response(200, { default_branch: "main" });
    }

    const getRefMatch = path.match(/^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/);
    if (getRefMatch && method === "GET") {
      const branch = decodeURIComponent(getRefMatch[1]);
      const ref = branches[branch];
      return ref ? response(200, { object: { sha: ref.sha } }) : response(404, { message: "Not Found" });
    }
    if (path === "/repos/acme/app/git/refs" && method === "POST") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      branches[branch] = {
        sha: body.sha,
        aheadBy: 0,
        files: { ...branches.main.files },
      };
      return response(201, { ref: body.ref });
    }
    const patchRefMatch = path.match(/^\/repos\/acme\/app\/git\/refs\/heads\/(.+)$/);
    if (patchRefMatch && method === "PATCH") {
      const branch = decodeURIComponent(patchRefMatch[1]);
      branches[branch] = {
        sha: body.sha,
        aheadBy: 0,
        files: { ...branches.main.files },
      };
      return response(200, { object: { sha: body.sha } });
    }

    const compareMatch = path.match(/^\/repos\/acme\/app\/compare\/(.+)\.\.\.(.+)$/);
    if (compareMatch && method === "GET") {
      const head = decodeURIComponent(compareMatch[2]);
      return response(200, { ahead_by: branches[head]?.aheadBy ?? 0 });
    }

    const contentsMatch = path.match(/^\/repos\/acme\/app\/contents\/(.+)$/);
    if (contentsMatch && method === "GET") {
      const remotePath = decodeURIComponent(contentsMatch[1]);
      const ref = decodeURIComponent(url.searchParams.get("ref") ?? "main");
      const content = branches[ref]?.files[remotePath];
      if (content === undefined) return response(404, { message: "Not Found" });
      return response(200, {
        type: "file",
        sha: fileSha(content),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (contentsMatch && method === "PUT") {
      const remotePath = decodeURIComponent(contentsMatch[1]);
      const branch = body.branch;
      branches[branch].files[remotePath] = Buffer.from(body.content, "base64").toString("utf-8");
      branches[branch].aheadBy = 1;
      return response(200, { content: { path: remotePath } });
    }
    if (contentsMatch && method === "DELETE") {
      const remotePath = decodeURIComponent(contentsMatch[1]);
      const branch = body.branch;
      delete branches[branch].files[remotePath];
      branches[branch].aheadBy = 1;
      return response(200, { commit: { sha: "del-sha" } });
    }

    if (path === "/repos/acme/app/pulls" && method === "GET") {
      return response(200, pulls);
    }
    if (path === "/repos/acme/app/pulls" && method === "POST") {
      const pr = {
        number: 123,
        html_url: "https://github.com/acme/app/pull/123",
        head: body.head,
        base: { ref: body.base },
      };
      pulls.push(pr);
      return response(201, pr);
    }
    const prMatch = path.match(/^\/repos\/acme\/app\/pulls\/(\d+)$/);
    if (prMatch && method === "PATCH") {
      const pr = pulls.find((p) => p.number === Number(prMatch[1]));
      if (!pr) return response(404, { message: "Not Found" });
      pr.base.ref = body.base;
      return response(200, pr);
    }

    return response(500, { message: `Unhandled fake GitHub route: ${method} ${path}` });
  }) as typeof fetch;

  return { fetchImpl, branches, pulls, calls };
}

describe("syncWorkflowTemplates", () => {
  it("opens a sync PR with workflow files and seed templates", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch();

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.status).toBe("pr-opened");
    expect(result.prUrl).toBe("https://github.com/acme/app/pull/123");
    expect(result.changedFiles).toEqual([
      ".github/workflows/claude-implement.yml",
      ".github/workflows/claude-plan.yml",
      "WORKFLOW.md",
      "PLANNING.md",
    ]);
    expect(fake.branches["sync/ai-implement"].files[".github/workflows/claude-implement.yml"]).toBe("implement-yml\n");
    expect(fake.branches["sync/ai-implement"].files["WORKFLOW.md"]).toBe("workflow-md\n");
    const writeCalls = fake.calls.filter((call) => ["POST", "PUT", "PATCH"].includes(call.method));
    expect(writeCalls.length).toBeGreaterThan(0);
    expect(writeCalls.every((call) => (call.headers as Record<string, string>)["Content-Type"] === "application/json")).toBe(true);
  });

  it("does not overwrite repo-owned prompt templates when they already exist on base", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch({
      mainFiles: {
        "WORKFLOW.md": "custom workflow\n",
        "PLANNING.md": "custom planning\n",
      },
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.changedFiles).toEqual([
      ".github/workflows/claude-implement.yml",
      ".github/workflows/claude-plan.yml",
    ]);
    expect(fake.branches["sync/ai-implement"].files["WORKFLOW.md"]).toBe("custom workflow\n");
    expect(fake.branches["sync/ai-implement"].files["PLANNING.md"]).toBe("custom planning\n");
  });

  it("returns up-to-date when the sync branch already matches templates and no PR is open", async () => {
    const templatesRoot = makeTemplatesRoot();
    const syncedFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/claude-plan.yml": "plan-yml\n",
      "WORKFLOW.md": "workflow-md\n",
      "PLANNING.md": "planning-md\n",
    };
    const fake = makeGithubFetch({
      mainFiles: syncedFiles,
      syncFiles: syncedFiles,
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.status).toBe("up-to-date");
    expect(result.changedFiles).toEqual([]);
    expect(result.prUrl).toBeNull();
  });

  it("updates an existing sync PR when files change", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch({
      syncFiles: {
        ".github/workflows/claude-implement.yml": "old implement\n",
      },
      existingPr: {
        number: 77,
        html_url: "https://github.com/acme/app/pull/77",
        head: "sync/ai-implement",
        base: { ref: "develop" },
      },
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.status).toBe("pr-updated");
    expect(result.prNumber).toBe(77);
    expect(result.prUrl).toBe("https://github.com/acme/app/pull/77");
    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0].base.ref).toBe("main");
  });

  it("returns pr-existing when no files changed and a sync PR is already open", async () => {
    const templatesRoot = makeTemplatesRoot();
    const syncedFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/claude-plan.yml": "plan-yml\n",
      "WORKFLOW.md": "workflow-md\n",
      "PLANNING.md": "planning-md\n",
    };
    const fake = makeGithubFetch({
      mainFiles: syncedFiles,
      syncFiles: syncedFiles,
      existingPr: {
        number: 88,
        html_url: "https://github.com/acme/app/pull/88",
        head: "sync/ai-implement",
        base: { ref: "main" },
      },
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.status).toBe("pr-existing");
    expect(result.prNumber).toBe(88);
    expect(result.changedFiles).toEqual([]);
  });

  it("force-resets a stale sync branch that is ahead of base to produce a clean diff", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch({
      syncFiles: {
        ".github/workflows/claude-implement.yml": "OLD-implement\n",
        "stale-leftover.txt": "stale\n",
      },
      syncAheadBy: 2,
      existingPr: {
        number: 55,
        html_url: "https://github.com/acme/app/pull/55",
        head: "sync/ai-implement",
        base: { ref: "main" },
      },
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    // The existing open PR is reused, not duplicated.
    expect(result.status).toBe("pr-updated");
    expect(result.prNumber).toBe(55);
    expect(fake.pulls).toHaveLength(1);

    // The branch was force-reset to the current base before templates were applied.
    expect(
      fake.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.path.includes("/git/refs/heads/") &&
          (call.body as { sha?: string; force?: boolean }).sha === "base-sha" &&
          (call.body as { sha?: string; force?: boolean }).force === true,
      ),
    ).toBe(true);

    // Stale non-template leftover is gone; current template content is present.
    expect(fake.branches["sync/ai-implement"].files["stale-leftover.txt"]).toBeUndefined();
    expect(fake.branches["sync/ai-implement"].files[".github/workflows/claude-implement.yml"]).toBe("implement-yml\n");
  });

  it("throws when an always-synced workflow template is missing", async () => {
    const templatesRoot = makeTemplatesRoot();
    rmSync(join(templatesRoot, "workflows/claude-plan.yml"));
    const fake = makeGithubFetch();

    await expect(syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    })).rejects.toThrow("Missing workflow template: workflows/claude-plan.yml");
  });

  it("throws a descriptive error when the base branch does not exist", async () => {
    const templatesRoot = makeTemplatesRoot();
    // The fake repo only has "main"; a mapping pointing at "develop" hits a 404 on the ref lookup.
    const fake = makeGithubFetch();

    await expect(syncWorkflowTemplates({
      mapping: { ...mapping, defaultBranch: "develop" },
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    })).rejects.toThrow(
      'Base branch "develop" does not exist in acme/app. ' +
        "The repository may be empty (no commits yet) or the configured branch name is wrong. " +
        "Push an initial commit or correct the branch name in the project settings.",
    );
  });

  it("surfaces the missing-base-branch message verbatim through classifySyncError (the sync-status path)", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch();

    // Mirrors runWorkflowSync in workflow-sync-queue.ts, which stores
    // classifySyncError(err) on the failed job; the admin UI renders its .message.
    const err = await syncWorkflowTemplates({
      mapping: { ...mapping, defaultBranch: "develop" },
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const classified = classifySyncError(err);
    expect(classified.category).toBe("unknown");
    expect(classified.message).toBe((err as Error).message);
    expect(classified.message).toContain('Base branch "develop" does not exist in acme/app');
  });

  it("prefixes the sync branch when the mapping sets a branchPrefix", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch();

    const result = await syncWorkflowTemplates({
      mapping: { ...mapping, branchPrefix: "pr" },
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.syncBranch).toBe("pr/sync/ai-implement");
    expect(fake.branches["pr/sync/ai-implement"]).toBeDefined();
    expect(fake.pulls[0].head).toBe("pr/sync/ai-implement");
  });

  it("uses the unprefixed sync branch when the mapping has no branchPrefix", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch();

    const result = await syncWorkflowTemplates({
      mapping: { ...mapping, branchPrefix: null },
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.syncBranch).toBe("sync/ai-implement");
  });

  it("does not prefix an explicitly provided syncBranch", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch();

    const result = await syncWorkflowTemplates({
      mapping: { ...mapping, branchPrefix: "pr" },
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      syncBranch: "sync/ai-implement",
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.syncBranch).toBe("sync/ai-implement");
  });

  it("REMOVE_FILES: removes comment-trigger.yml when present on sync branch", async () => {
    const templatesRoot = makeTemplatesRoot();
    const mainFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/claude-plan.yml": "plan-yml\n",
      ".github/workflows/comment-trigger.yml": "old-comment-trigger\n",
      "WORKFLOW.md": "workflow-md\n",
      "PLANNING.md": "planning-md\n",
    };
    const fake = makeGithubFetch({ mainFiles });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.changedFiles).toContain(".github/workflows/comment-trigger.yml");
    expect(fake.branches["sync/ai-implement"].files[".github/workflows/comment-trigger.yml"]).toBeUndefined();
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.includes("comment-trigger.yml"))).toBe(true);
  });

  it("REMOVE_FILES: no-ops when comment-trigger.yml is absent from sync branch", async () => {
    const templatesRoot = makeTemplatesRoot();
    const mainFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/claude-plan.yml": "plan-yml\n",
      "WORKFLOW.md": "workflow-md\n",
      "PLANNING.md": "planning-md\n",
    };
    const fake = makeGithubFetch({ mainFiles });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.changedFiles).not.toContain(".github/workflows/comment-trigger.yml");
    expect(fake.calls.every((call) => call.method !== "DELETE")).toBe(true);
  });

  it("REMOVE_FILES: removed file is the sole entry in changedFiles, triggering PR creation", async () => {
    const templatesRoot = makeTemplatesRoot();
    const mainFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/claude-plan.yml": "plan-yml\n",
      ".github/workflows/comment-trigger.yml": "old-comment-trigger\n",
      "WORKFLOW.md": "workflow-md\n",
      "PLANNING.md": "planning-md\n",
    };
    const fake = makeGithubFetch({ mainFiles });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(result.status).toBe("pr-opened");
    expect(result.changedFiles).toEqual([".github/workflows/comment-trigger.yml"]);
  });

});

describe("classifySyncError", () => {
  it("repo-not-found for a 404 on the bare repo path", () => {
    expect(classifySyncError(new GitHubApiError({ status: 404, path: "/repos/acme/app" })).category).toBe("repo-not-found");
  });

  it("app-not-installed for a 404 on an installation path", () => {
    expect(classifySyncError(new GitHubApiError({ status: 404, path: "/users/acme/installation" })).category).toBe("app-not-installed");
  });

  it("clock-skew-suspected for a 401 (never app-not-installed)", () => {
    expect(classifySyncError(new GitHubApiError({ status: 401, path: "/orgs/acme/installation" })).category).toBe("clock-skew-suspected");
  });

  it("permission-denied for a 403 on a contents path", () => {
    expect(classifySyncError(new GitHubApiError({ status: 403, path: "/repos/acme/app/contents/.github/workflows/claude-implement.yml" })).category).toBe("permission-denied");
  });

  it("unknown for a 404 on a non-repo, non-installation path", () => {
    expect(classifySyncError(new GitHubApiError({ status: 404, path: "/repos/acme/app/contents/WORKFLOW.md" })).category).toBe("unknown");
  });
  
  it("unknown with the raw message for a non-GitHubApiError", () => {
    const r = classifySyncError(new Error("boom"));
    expect(r.category).toBe("unknown");
    expect(r.message).toBe("boom");
  });
});
