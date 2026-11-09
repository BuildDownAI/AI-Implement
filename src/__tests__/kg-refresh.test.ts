import { resolveWorkflowCapabilities, __clearWorkflowProbeCacheForTests } from "../workflow-probe.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { postDryRunReport } from "../kg-refresh-rail.js";
import { makeKgRefresh, runKgRefreshPreflight, materializeArgs, type KgRefreshHandle, type RefreshOutcome, migrateLegacyDryRunOutcomes } from "../kg-refresh.js";
import { testDb } from "./helpers/test-db.js";
import { testDir } from "./helpers/test-dir.js";

const materializeState = vi.hoisted(() => ({ direct: false }));
vi.mock("../runner-mode.js", async (orig) => ({
  ...(await orig<typeof import("../runner-mode.js")>()),
  getKgMaterializeDirect: () => ({ enabled: materializeState.direct, source: "db" as const }),
}));

const NAMESPACE = "https://kg.test.example/";

function makeTarball(dir: string): Buffer {
  // extractSource strips one leading component, so wrap in a top-level dir.
  const wrap = testDir("kgtar");
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  // `dir/.` copies CONTENTS on both BSD (macOS) and GNU (Linux) cp — a bare
  // trailing slash nests the directory on GNU, which broke this fixture in CI.
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

describe("kg-refresh", () => {
  // Regression pin: AII-518 — deploy hold blocks kg-refresh start (reverse direction of the interlock).
  it("never reaches an embedding path: the staging command is materialize, full pass", () => {
    expect(materializeArgs()).toEqual(["-m", "kg_ingest.materialize"]);
    expect(materializeArgs().join(" ")).not.toMatch(/embed|cli/);
  });

  // AII-599: KG_MATERIALIZE_DIRECT gates the low-memory --direct path.
  describe("KG_MATERIALIZE_DIRECT", () => {
    afterEach(() => {
      materializeState.direct = false;
      vi.restoreAllMocks();
    });

    it("appends --direct to materializeArgs() when the flag is true", () => {
      materializeState.direct = true;
      expect(materializeArgs()).toEqual(["-m", "kg_ingest.materialize", "--direct"]);
      expect(materializeArgs().join(" ")).not.toMatch(/embed|cli/);
    });

    it("leaves materializeArgs() unchanged when the setting is off", () => {
      materializeState.direct = false;
      expect(materializeArgs()).toEqual(["-m", "kg_ingest.materialize"]);
    });

  });

  it("Dockerfile bakes a default-if-unset KG_BACKEND so a sidecar-set nt_parts value survives start.sh (AII-599)", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/KG_BACKEND="\$\{KG_BACKEND:-rdflib\}"/);
  });

  // ---- The dry-run PR-check surface (AII-633, AII-636, AII-640, AII-977) --------
  // The refresh lifecycle runs in the KgRefresh workflow; no outcome is stored. The handle
  // only evicts the PR's held head through the ingress client, faked here.

  describe("dry-run report surface", () => {
    const REPORT = { repo: "TestOrg/test-kg", prNumber: 42, sha: "deadbeef" };
    const okOutcome: RefreshOutcome = {
      ok: true,
      at: 1,
      detail: "dry-run: guard passed: no shrink",
      stampBefore: null,
      stampAfter: null,
      dryRun: true,
      partTable: [{ part: "comment.nt", prev: "9995", new: "9995" }],
    };
    const refusedOutcome: RefreshOutcome = {
      ok: false,
      at: 2,
      detail: "dry-run: guard refused: content regression detected — comment.nt: shrank from 9995 to 3793 lines",
      stampBefore: null,
      stampAfter: null,
      dryRun: true,
      partTable: [{ part: "comment.nt", prev: "9995", new: "3793" }],
    };
    let postOrUpdateStickyCommentFn: ReturnType<typeof vi.fn>;
    let setCommitStatusFn: ReturnType<typeof vi.fn>;
    let forgetPrCall: ReturnType<typeof vi.fn>;

    function buildHandle(): KgRefreshHandle {
      postOrUpdateStickyCommentFn = vi.fn(async () => {});
      setCommitStatusFn = vi.fn(async () => {});
      forgetPrCall = vi.fn(async () => ({ status: "accepted" }));
      return makeKgRefresh({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        dryRunOutcomes: { forgetPr: forgetPrCall } as never,
      });
    }

    const reportDeps = () => ({
      githubAppId: "1",
      githubAppPrivateKey: "key",
      mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
      postOrUpdateStickyCommentFn: postOrUpdateStickyCommentFn as never,
      setCommitStatusFn: setCommitStatusFn as never,
    });

    it("postDryRunReport() posts the outcome's comment and status", async () => {
      buildHandle();
      await postDryRunReport(reportDeps(), REPORT, okOutcome);

      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
      const [, owner, repo, prNumber, marker, body] = postOrUpdateStickyCommentFn.mock.calls[0] as [string, string, string, number, string, string];
      expect(owner).toBe("TestOrg");
      expect(repo).toBe("test-kg");
      expect(prNumber).toBe(42);
      expect(marker).toBe("## kg-refresh dry-run");
      expect(body).toContain("## kg-refresh dry-run — deadbeef");
      expect(body).toContain("comment.nt");
      expect(body).not.toContain("decision gate");
      expect(setCommitStatusFn).toHaveBeenCalledTimes(1);
    });

    it("forgetPr() asks the KgRepo object to drop the PR", async () => {
      const handle = buildHandle();

      await handle.forgetPr(REPORT.repo, REPORT.prNumber);

      expect(forgetPrCall).toHaveBeenCalledWith("TestOrg/test-kg", { repo: REPORT.repo, prNumber: 42 });
    });

    it("a refused dry-run reads refused, points at the refresh decision gate, and fails the status even with a stale acceptBaseline", async () => {
      buildHandle();

      // A queued input stored before the label was removed may still carry acceptBaseline.
      await postDryRunReport(reportDeps(), { ...REPORT, acceptBaseline: true } as typeof REPORT, refusedOutcome);

      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
      const body = postOrUpdateStickyCommentFn.mock.calls[0]![5] as string;
      expect(body).toContain("guard refused");
      expect(body).toContain("A shrink is accepted at the decision gate of the refresh that runs after this PR merges.");
      expect(body).not.toContain("accepted by label");
      const statusCall = setCommitStatusFn.mock.calls[0] as [string, string, string, string, { state: string }];
      expect(statusCall[4].state).toBe("failure");
    });
  });

  describe("migrateLegacyDryRunOutcomes (AII-977)", () => {
    function fakeDb(value?: string) {
      const rows = new Map<string, string>(value === undefined ? [] : [["kg_refresh_dry_run_outcomes", value]]);
      return {
        rows,
        db: {
          prepare: (sql: string) => ({
            get: (key: string) => (rows.has(key) ? { value: rows.get(key)! } : undefined),
            run: (key: string) => { if (/DELETE/.test(sql)) rows.delete(key); },
          }),
        } as never,
      };
    }

    it("deletes a present row and logs its entry count", () => {
      const { db, rows } = fakeDb(JSON.stringify([["a#1", {}], ["a#2", {}]]));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(migrateLegacyDryRunOutcomes(db)).toBe(2);
        expect(rows.size).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("(2 entries)"));
      } finally {
        log.mockRestore();
      }
    });

    it("deletes an unparsable row, counting zero", () => {
      const { db, rows } = fakeDb("not json");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(migrateLegacyDryRunOutcomes(db)).toBe(0);
        expect(rows.size).toBe(0);
      } finally {
        log.mockRestore();
      }
    });

    it("is a no-op when the row is absent", () => {
      const { db } = fakeDb();
      expect(migrateLegacyDryRunOutcomes(db)).toBeNull();
    });
  });

  // ---- AII-585: credential preflight gate ----------------------------------------

  describe("preflight gate", () => {
    let probeRepo: ReturnType<typeof vi.fn>;
    let mintTokenPf: ReturnType<typeof vi.fn>;
    let fetchWorkflowFile: ReturnType<typeof vi.fn>;
    let fetchCompare: ReturnType<typeof vi.fn>;
    let preflightTarball: Buffer;

    // A workflow declaring both inputs required by the KG envelope sender.
    const WORKFLOW_WITH_RUNNER_PHASE = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      run_config:",
      "        required: true",
      "      run_publication_token:",
      "        required: false",
      "      runner_phase:",
      "        required: false",
      "jobs:",
      "  implement:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
    ].join("\n");

    function buildPreflight() {
      // Build a fixture tarball whose sources.yml includes code_repo and a secondary repo.
      const pfRepo = testDir("kgpf");
      writeFileSync(
        join(pfRepo, "sources.yml"),
        [
          `namespace: ${NAMESPACE}`,
          `code_repo: TestOrg/main-repo`,
          `secondary_repos:`,
          `  - slug: TestOrg/secondary-repo`,
        ].join("\n"),
      );
      mkdirSync(join(pfRepo, "snapshot"), { recursive: true });
      preflightTarball = makeTarball(pfRepo);

      // mintTokenPf always succeeds; overrides can make specific calls fail.
      mintTokenPf = vi.fn(async () => ({ token: "tok", expiresAt: "" }));
      // probeRepo defaults to success; overrides can make specific slugs fail.
      probeRepo = vi.fn(async () => ({ ok: true, status: 200 }));
      // Default to a workflow that accepts the KG envelope and publication token.
      fetchWorkflowFile = vi.fn(async () => ({ status: 200, content: WORKFLOW_WITH_RUNNER_PHASE }));
      // fetchCompare defaults to no drift; overrides can flip this. Always mocked so these
      // tests never make a real network call to GitHub's compare API.
      fetchCompare = vi.fn(async () => ({ status: 200, behindBy: 0 }));
    }

    // ---- AII-594 / AII-654: workflow:envelope row -----------------------------------

    it.each([
      ["run_config without publication input", "on:\n  workflow_dispatch:\n    inputs:\n      run_config: {}"],
      ["private marker without publication input", "# ai-implement-capability: private-run-config-v1\non:\n  workflow_dispatch:\n    inputs:\n      run_config: {}"],
      ["publication input without run_config", "on:\n  workflow_dispatch:\n    inputs:\n      run_publication_token: {}"],
      ["absent inputs", "on:\n  workflow_dispatch:"],
      ["malformed YAML", "on: ["],
      ["both inputs inline publication", "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      run_publication_token: { required: false, type: string }"],
      ["both inputs inline declarations", "on:\n  workflow_dispatch:\n    inputs:\n      run_config: {required: true}\n      run_publication_token: {required: false}"],
      ["both inputs block declarations", "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      run_publication_token:\n        required: false"],
      ["both inputs null declarations", "on: {workflow_dispatch: {inputs: {run_config: null, run_publication_token: null}}}"],
      ["publication only outside inputs", "on:\n  workflow_dispatch:\n    inputs:\n      run_config: {}\njobs:\n  run_publication_token:"],
      ["run config only outside inputs", "on:\n  workflow_dispatch:\n    inputs:\n      run_publication_token: {}\nenv:\n  run_config:"],
      ["publication comment outside inputs", "on:\n  workflow_dispatch:\n    inputs:\n      run_config: {}\n      # run_publication_token:"],
      ["malformed root sequence", "- on: {workflow_dispatch: {inputs: {run_config: {}, run_publication_token: {}}}}"],
      ["malformed on sequence", "on: [{workflow_dispatch: {inputs: {run_config: {}, run_publication_token: {}}}}]"],
      ["both inputs flow map", "on: { workflow_dispatch: { inputs: { run_config: {required: true}, run_publication_token: {required: false} } } }"],
      ["both inputs quoted keys", '\'on\': { "workflow_dispatch": { "inputs": { "run_config": {}, "run_publication_token": {} } } }'],
      ["malformed inputs sequence", "on: {workflow_dispatch: {inputs: [run_config, run_publication_token]}}"],
      ["malformed dispatch scalar", "on: {workflow_dispatch: run_config}"],
      ["non-input mappings", "jobs:\n  run_config:\n  run_publication_token:\nenv:\n  run_config:\n  run_publication_token:\nsteps:\n  run_config:\n  run_publication_token:"],
      ["comments only", "# run_config:\n# run_publication_token:"],
      ["both inputs", WORKFLOW_WITH_RUNNER_PHASE],
      ["both inputs with private capability", "# ai-implement-capability: private-run-config-v1\n" + WORKFLOW_WITH_RUNNER_PHASE],
    ])("checks the KG workflow contract: %s", async (name, content) => {
      buildPreflight();
      const ok = name.startsWith("both inputs");
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: vi.fn(async () => ({ status: 200, content })) as never,
        fetchCompare: fetchCompare as never,
      });
      __clearWorkflowProbeCacheForTests();
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"),
      })));
      const capabilities = await resolveWorkflowCapabilities({
        owner: "TestOrg", repo: "test-kg", workflowFile: "claude-implement.yml",
        token: "tok", ref: "release/requested", fetchImpl,
      });
      expect(capabilities.supportsRunPublicationToken).toBe(ok);
      expect(fetchImpl.mock.calls[0]?.[0]).toContain("?ref=release%2Frequested");
      expect(result.ok).toBe(ok);
      const row = result.results.find((r) => r.grant === "workflow:envelope");
      expect(row).toMatchObject({ ok, status: 200 });
      if (!ok) expect(row?.hint).toContain("sync-workflows");
      else expect(row).not.toHaveProperty("hint");
    });

    it.each([
      ["modern default, old requested", true, "old", false, 200],
      ["old default, modern requested", false, "modern", true, 200],
      ["requested read throws", true, "throws", false, 0],
      ["requested read missing", true, "missing", false, 404],
    ] as const)("checks the requested workflow ref: %s", async (_name, modernDefault, requested, ok, status) => {
      buildPreflight();
      const oldWorkflow = "on:\n  workflow_dispatch:\n    inputs:\n      run_config: {}";
      const fetchWorkflow = vi.fn(async (_token: string, _owner: string, _repo: string, ref: string) => {
        if (ref === "release/requested") {
          if (requested === "throws") throw new Error("read failed");
          if (requested === "missing") return { status: 404, content: null };
          return { status: 200, content: requested === "modern" ? WORKFLOW_WITH_RUNNER_PHASE : oldWorkflow };
        }
        return { status: 200, content: modernDefault ? WORKFLOW_WITH_RUNNER_PHASE : oldWorkflow };
      });
      const fetchTarball = vi.fn(async () => preflightTarball);
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        kgSourceRef: "release/requested",
        mintToken: mintTokenPf as never,
        fetchTarball: fetchTarball as never,
        fetchDefaultBranch: async () => "main",
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflow,
        fetchCompare: fetchCompare as never,
      });
      expect(result.ok).toBe(ok);
      expect(result.results.find((r) => r.grant === "workflow:envelope")).toMatchObject({ ok, status });
      expect(fetchWorkflow).toHaveBeenCalledExactlyOnceWith("tok", "TestOrg", "test-kg", "release/requested");
      expect(fetchTarball).toHaveBeenCalledWith("tok", "TestOrg", "test-kg", "main");
    });

    it("workflow row failing does not disturb the other row shapes", async () => {
      const failingWorkflowFetch = vi.fn(async () => ({ status: 404, content: null }));
      buildPreflight();

      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: failingWorkflowFetch as never,
        fetchCompare: fetchCompare as never,
      });

      const byGrant = (repo: string, grant: string) => result.results.find((r) => r.repo === repo && r.grant === grant);
      expect(byGrant("TestOrg/test-kg", "contents:write")).toMatchObject({ ok: true, status: 200 });
      expect(byGrant("TestOrg/main-repo", "contents:read")).toMatchObject({ ok: true, status: 200 });
      expect(byGrant("TestOrg/secondary-repo", "pull_requests:read")).toMatchObject({ ok: true, status: 200 });
      expect(byGrant("TestOrg/test-kg", "workflow:envelope")).toMatchObject({ ok: false, status: 404 });
      expect(byGrant("BuildDownAI/bd-knowledge-graph-base", "base:drift")).toMatchObject({ ok: true, status: 200 });
    });

    // ---- AII-633: statuses:write rows (advisory — never fail the preflight) --------

    it("statuses:write granted on both repos — both rows ok:true with no hint", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: fetchCompare as never,
      });
      const byGrant = (repo: string, grant: string) => result.results.find((r) => r.repo === repo && r.grant === grant);
      expect(byGrant("TestOrg/test-kg", "statuses:write")).toMatchObject({ ok: true, status: 200 });
      const baseRow = byGrant("BuildDownAI/bd-knowledge-graph-base", "statuses:write");
      expect(baseRow).toMatchObject({ ok: true, status: 200 });
      expect(baseRow).not.toHaveProperty("hint");
    });

    it("statuses:write denied on the KG source repo — row still ok:true, with a hint, and does not fail the overall preflight", async () => {
      const mintDenyStatuses = vi.fn(async (_id: string, _key: string, _owner: string, opts: Record<string, unknown>) => {
        if ((opts.permissions as Record<string, string>)?.statuses === "write") {
          throw new Error("403 Forbidden");
        }
        return { token: "tok", expiresAt: "" };
      });
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintDenyStatuses as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: fetchCompare as never,
      });
      const row = result.results.find((r) => r.repo === "TestOrg/test-kg" && r.grant === "statuses:write");
      expect(row).toMatchObject({ ok: true, status: 0 });
      expect(row?.hint).toContain("statuses: write");
      expect(result.ok).toBe(true);
    });

    it("kgBaseRepo set — statuses:write 'base repo' row probes the webhook's base repo, not sources.yml's base_repo (AII-633)", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        kgBaseRepo: "TestOrg/webhook-base",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: fetchCompare as never,
      });
      const byGrant = (repo: string, grant: string) => result.results.find((r) => r.repo === repo && r.grant === grant);
      expect(byGrant("TestOrg/webhook-base", "statuses:write")).toMatchObject({ ok: true, status: 200 });
      expect(byGrant("BuildDownAI/bd-knowledge-graph-base", "statuses:write")).toBeUndefined();
      // base:drift is unrelated to the webhook's target and still checks sources.yml's base_repo.
      expect(byGrant("BuildDownAI/bd-knowledge-graph-base", "base:drift")).toMatchObject({ ok: true, status: 200 });
    });

    it("kgBaseRepo absent — statuses:write 'base repo' row falls back to sources.yml's base_repo (pre-AII-633 behaviour)", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: fetchCompare as never,
      });
      const byGrant = (repo: string, grant: string) => result.results.find((r) => r.repo === repo && r.grant === grant);
      expect(byGrant("BuildDownAI/bd-knowledge-graph-base", "statuses:write")).toMatchObject({ ok: true, status: 200 });
    });

    // ---- AII-598: base:drift row --------------------------------------------------

    it("no drift — row is ok:true with no hint key", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: vi.fn(async () => ({ status: 200, behindBy: 0 })) as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row).toMatchObject({ ok: true, status: 200 });
      expect(row).not.toHaveProperty("hint");
    });

    it("custom base_repo: — row's repo field reflects the configured slug", async () => {
      const pfRepo = testDir("kgpf-base");
      writeFileSync(
        join(pfRepo, "sources.yml"),
        [
          `namespace: ${NAMESPACE}`,
          `code_repo: TestOrg/main-repo`,
          `base_repo: SomeOrg/some-base`,
        ].join("\n"),
      );
      mkdirSync(join(pfRepo, "snapshot"), { recursive: true });
      const customTarball = makeTarball(pfRepo);

      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => customTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: vi.fn(async () => ({ status: 200, behindBy: 0 })) as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row?.repo).toBe("SomeOrg/some-base");
    });

    it("no base_repo: in sources.yml — row's repo field defaults to BuildDownAI/bd-knowledge-graph-base", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: vi.fn(async () => ({ status: 200, behindBy: 0 })) as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row?.repo).toBe("BuildDownAI/bd-knowledge-graph-base");
    });

    it("base repo unreadable (compare 404) — hint is 'base drift unknown', ok:true, no throw", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: vi.fn(async () => ({ status: 404, behindBy: null })) as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row).toMatchObject({ ok: true, status: 404, hint: "base drift unknown" });
      expect(result.ok).toBe(true);
    });

    it("base repo's default-branch lookup itself throws — real status surfaces, not 0", async () => {
      const fetchDefaultBranchBaseThrows = vi.fn(async (_token: string, owner: string, repoName: string) => {
        if (owner === "BuildDownAI" && repoName === "bd-knowledge-graph-base") {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        return "main";
      });
      const compareForThisTest = vi.fn(async () => ({ status: 200, behindBy: 0 }));
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: fetchDefaultBranchBaseThrows as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: compareForThisTest as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row).toMatchObject({ ok: true, status: 404, hint: "base drift unknown" });
      expect(result.ok).toBe(true);
      // The compare call never happens once the base branch can't be resolved.
      expect(compareForThisTest).not.toHaveBeenCalled();
    });

    it("compare call throws — status 0, hint 'base drift unknown', no exception propagates", async () => {
      const result = await runKgRefreshPreflight({
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        mintToken: mintTokenPf as never,
        fetchTarball: vi.fn(async () => preflightTarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        probeRepo: probeRepo as never,
        fetchWorkflowFile: fetchWorkflowFile as never,
        fetchCompare: vi.fn(async () => { throw new Error("network error"); }) as never,
      });
      const row = result.results.find((r) => r.grant === "base:drift");
      expect(row).toMatchObject({ ok: true, status: 0, hint: "base drift unknown" });
      expect(result.ok).toBe(true);
    });

  });
});

describe("kg-refresh production wiring (AII-901)", () => {
  type IndexModule = typeof import("../index.js");
  let idx: IndexModule;
  let logMod: typeof import("../log.js");
  let dedupMod: typeof import("../dedup.js");
  let hold: typeof import("../deploy-hold.js");

  beforeEach(async () => {
    ({ idx, logMod, dedupMod, hold } = (
      await testDb({
        modules: {
          idx: () => import("../index.js"),
          logMod: () => import("../log.js"),
          dedupMod: () => import("../dedup.js"),
          hold: () => import("../deploy-hold.js"),
        },
      })
    ).modules);
  });


  const unavailable = { status: "unavailable" as const, content: [] };
  const held = (v: boolean) => () => v;

  it("makeKgDryRunEnqueue skips the ingress while Restate is not ready (AII-1405)", async () => {
    const ingress = { enqueueDryRun: vi.fn().mockResolvedValue({ status: "accepted" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = { prNumber: 3 } as never;
    expect(await idx.makeKgDryRunEnqueue("Org/kg", ingress as never, () => false)("k-1", entry, { idempotencyKey: "d" })).toEqual({ status: "unavailable" });
    expect(ingress.enqueueDryRun).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("k-1");
    warn.mockRestore();
  });

  it("makeKgDryRunEnqueue calls the ingress when ready and answers unavailable with no slug", async () => {
    const ingress = { enqueueDryRun: vi.fn().mockResolvedValue({ status: "accepted" }) };
    const entry = { prNumber: 3 } as never;
    const opts = { idempotencyKey: "d" };
    expect(await idx.makeKgDryRunEnqueue("Org/kg", ingress as never, () => true)("k-1", entry, opts)).toEqual({ status: "accepted" });
    expect(ingress.enqueueDryRun).toHaveBeenCalledWith("Org/kg", { key: "k-1", prNumber: 3 }, opts);
    ingress.enqueueDryRun.mockClear();
    for (const r of [true, false]) {
      expect(await idx.makeKgDryRunEnqueue(undefined, ingress as never, () => r)("k-1", entry, opts)).toEqual({ status: "unavailable" });
    }
    expect(ingress.enqueueDryRun).not.toHaveBeenCalled();
  });

  it("cancel cancels the clicked row's dispatchId and reads no marker", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "accepted" }) };
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, vi.fn() as never, held(false));
    expect((await deps.cancel({ jobId: 1, dispatchId: "t-old", reason: "operator_cancelled" })).status).toBe(200);
    expect(client.cancel).toHaveBeenCalledWith("t-old", "operator_cancelled");
    expect(client.repoStatus).not.toHaveBeenCalled();
  });

  it("cancel answers 409 for not-found and for a row without a dispatchId", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "not-found" }) };
    const decide = vi.fn().mockResolvedValue({ status: "ok", isError: true, content: [{ type: "text", text: "no-decision-open" }] });
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, decide as never, held(false));
    expect(await deps.cancel({ jobId: 1, dispatchId: "t-1", reason: "r" })).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
    client.cancel.mockClear();
    decide.mockClear();
    expect(await deps.cancel({ jobId: 1, dispatchId: null, reason: "r" })).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
    expect(client.cancel).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("a Stop on a held row, whose gate run has ended, cancels the hold through decide_kg_refresh with that row's trigger id", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "conflict", error: "no-refresh-in-flight" }) };
    const decide = vi.fn().mockResolvedValue({ status: "ok", content: [{ type: "text", text: "{\"decided\":\"cancel\"}" }] });
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, decide as never, held(false));
    expect(await deps.cancel({ jobId: 1, dispatchId: "t-held", reason: "operator_cancelled" })).toEqual({ status: 200, body: { cancelled: true } });
    expect(decide).toHaveBeenCalledWith("decide_kg_refresh", { action: "cancel", triggerId: "t-held" });
  });

  it("an unavailable Restate answers 409 deploy-in-progress during a hold", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "unavailable" }) };
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, vi.fn().mockResolvedValue(unavailable) as never, held(true));
    expect(await deps.trigger()).toEqual({ status: 409, body: { error: "deploy-in-progress" } });
    expect(await deps.status()).toEqual({ status: 409, body: { error: "deploy-in-progress", deployHeld: true } });
    expect(await deps.cancel({ jobId: 1, dispatchId: "t-1", reason: "r" })).toEqual({ status: 409, body: { error: "deploy-in-progress" } });
  });

  it("a deploy-held tool result answers 409 deploy-in-progress with the hold set, 503 without", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn() };
    const heldResult = vi.fn().mockResolvedValue({ status: "deploy-held" });
    const during = idx.makeKgRefreshAdminDeps("Org/kg", client as never, heldResult as never, held(true));
    expect(await during.trigger()).toEqual({ status: 409, body: { error: "deploy-in-progress" } });
    expect(await during.status()).toEqual({ status: 409, body: { error: "deploy-in-progress", deployHeld: true } });
    const after = idx.makeKgRefreshAdminDeps("Org/kg", client as never, heldResult as never, held(false));
    expect((await after.trigger()).status).toBe(503);
    expect((await after.status()).status).toBe(503);
  });

  it("deployHealth reports false/null with no hold and true/number once held", () => {
    expect(idx.deployHealth()).toEqual({ held: false, startedAt: null });
    hold.setDeployHold();
    try {
      expect(idx.deployHealth()).toEqual({ held: true, startedAt: expect.any(Number) });
    } finally {
      hold.clearDeployHold();
    }
  });

  it("an unavailable Restate answers 503 with no hold", async () => {
    const client = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "unavailable" }) };
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, vi.fn().mockResolvedValue(unavailable) as never, held(false));
    const body = { error: "restate-unavailable" };
    expect(await deps.trigger()).toEqual({ status: 503, body });
    expect(await deps.status()).toEqual({ status: 503, body });
    expect(await deps.cancel({ jobId: 1, dispatchId: "t-1", reason: "r" })).toEqual({ status: 503, body });
  });

  it("boot sweep closes in-flight kg-refresh rows and deletes the key; a second run is a no-op", () => {
    const kgJob = logMod.appendLog({ issueId: "kg-refresh", phase: "kg-refresh", executionMode: "github-actions" });
    const otherJob = logMod.appendLog({ issueId: "i-1", phase: "implementation" });
    dedupMod.getDb().prepare("INSERT INTO settings (key, value) VALUES ('kg_refresh_stage', '{}')").run();
    expect(idx.sweepLegacyKgRefreshRows()).toBe(1);
    expect(logMod.getJobById(kgJob)).toMatchObject({ status: "timed_out", conclusion: "legacy row closed at migration boot" });
    expect(logMod.getJobById(otherJob)?.status).not.toBe("timed_out");
    expect(dedupMod.getDb().prepare("SELECT 1 FROM settings WHERE key = 'kg_refresh_stage'").get()).toBeUndefined();
    expect(idx.sweepLegacyKgRefreshRows()).toBe(0);
  });

  it("boot sweep does nothing when the key is absent", () => {
    const kgJob = logMod.appendLog({ issueId: "kg-refresh", phase: "kg-refresh", executionMode: "github-actions" });
    expect(idx.sweepLegacyKgRefreshRows()).toBe(0);
    expect(logMod.getJobById(kgJob)?.status).not.toBe("timed_out");
  });
});
