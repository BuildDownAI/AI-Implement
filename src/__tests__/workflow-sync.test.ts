import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoMapping } from "../config.js";
import { syncWorkflowTemplates } from "../workflow-sync.js";

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
  writeFileSync(join(tempRoot, "workflows/comment-trigger.yml"), "comment-yml\n");
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
  existingPr?: FakePull | null;
}) {
  const branches: Record<string, { sha: string; aheadBy: number; files: Record<string, string> }> = {
    main: { sha: "base-sha", aheadBy: 0, files: { ...(opts?.mainFiles ?? {}) } },
  };
  if (opts?.syncFiles) {
    branches["sync/ai-implement"] = {
      sha: "sync-sha",
      aheadBy: 0,
      files: { ...opts.syncFiles },
    };
  }
  const pulls: FakePull[] = opts?.existingPr ? [opts.existingPr] : [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};

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

  return { fetchImpl, branches, pulls };
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
      ".github/workflows/comment-trigger.yml",
      ".github/workflows/claude-plan.yml",
      "WORKFLOW.md",
      "PLANNING.md",
    ]);
    expect(fake.branches["sync/ai-implement"].files[".github/workflows/claude-implement.yml"]).toBe("implement-yml\n");
    expect(fake.branches["sync/ai-implement"].files["WORKFLOW.md"]).toBe("workflow-md\n");
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
      ".github/workflows/comment-trigger.yml",
      ".github/workflows/claude-plan.yml",
    ]);
    expect(fake.branches["sync/ai-implement"].files["WORKFLOW.md"]).toBe("custom workflow\n");
    expect(fake.branches["sync/ai-implement"].files["PLANNING.md"]).toBe("custom planning\n");
  });

  it("returns up-to-date when the sync branch already matches templates and no PR is open", async () => {
    const templatesRoot = makeTemplatesRoot();
    const syncedFiles = {
      ".github/workflows/claude-implement.yml": "implement-yml\n",
      ".github/workflows/comment-trigger.yml": "comment-yml\n",
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
});
