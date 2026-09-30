import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeKgRefresh, runKgRefreshPreflight, materializeArgs, type KgRefreshHandle, type RefreshOutcome, type DryRunOutcomeEntry, MAX_TRACKED_PRS } from "../kg-refresh.js";

const NAMESPACE = "https://kg.test.example/";

function makeTarball(dir: string): Buffer {
  // extractSource strips one leading component, so wrap in a top-level dir.
  const wrap = mkdtempSync(join(tmpdir(), "kgtar-"));
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
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("appends --direct to materializeArgs() when the flag is true", () => {
      vi.stubEnv("KG_MATERIALIZE_DIRECT", "true");
      expect(materializeArgs()).toEqual(["-m", "kg_ingest.materialize", "--direct"]);
      expect(materializeArgs().join(" ")).not.toMatch(/embed|cli/);
    });

    it("leaves materializeArgs() unchanged when the flag is unset or any other value", () => {
      vi.stubEnv("KG_MATERIALIZE_DIRECT", "false");
      expect(materializeArgs()).toEqual(["-m", "kg_ingest.materialize"]);
    });

  });

  it("Dockerfile bakes a default-if-unset KG_BACKEND so a sidecar-set nt_parts value survives start.sh (AII-599)", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/KG_BACKEND="\$\{KG_BACKEND:-rdflib\}"/);
  });

  // ---- The dry-run PR-check surface (AII-633, AII-636, AII-640) -----------------
  // The refresh lifecycle runs in the KgRefresh workflow; what the handle keeps is the
  // per-PR outcome cache behind recordDryRunOutcome/reportDryRun/forgetPr. Most tests seed
  // the cache through the persisted store, the way a restarted handle finds it.

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
    let persistDryRunOutcomes: ReturnType<typeof vi.fn>;

    function buildHandle(stored: DryRunOutcomeEntry[] | null | (() => never) = null): KgRefreshHandle {
      postOrUpdateStickyCommentFn = vi.fn(async () => {});
      setCommitStatusFn = vi.fn(async () => {});
      persistDryRunOutcomes = vi.fn();
      return makeKgRefresh({
        sidecar: { restart: vi.fn(async () => {}) },
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        dataRoot: "/nonexistent-kg-root",
        kgDir: "/nonexistent-kg",
        mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
        fetchTarball: vi.fn() as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        postOrUpdateStickyCommentFn: postOrUpdateStickyCommentFn as never,
        setCommitStatusFn: setCommitStatusFn as never,
        persistDryRunOutcomes: persistDryRunOutcomes as never,
        loadDryRunOutcomes: (() => (typeof stored === "function" ? stored() : stored)) as never,
      });
    }

    const entryFor = (report: { repo: string; prNumber: number; sha: string }, outcome: RefreshOutcome): DryRunOutcomeEntry =>
      [`${report.repo}#${report.prNumber}`, { sha: report.sha, outcome }];

    it("reportDryRun() re-posts the stored outcome's comment and status", async () => {
      const handle = buildHandle([entryFor(REPORT, okOutcome)]);

      await handle.reportDryRun({ ...REPORT, acceptBaseline: true });

      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
      const [, owner, repo, prNumber, marker, body] = postOrUpdateStickyCommentFn.mock.calls[0] as [string, string, string, number, string, string];
      expect(owner).toBe("TestOrg");
      expect(repo).toBe("test-kg");
      expect(prNumber).toBe(42);
      expect(marker).toBe("## kg-refresh dry-run");
      expect(body).toContain("## kg-refresh dry-run — deadbeef");
      expect(body).toContain("comment.nt");
      // Outcome was a success (no shrink), so the label has no wording effect here.
      expect(body).not.toContain("accepted by label");
      expect(setCommitStatusFn).toHaveBeenCalledTimes(1);
    });

    it("reportDryRun() never re-posts another PR's dry-run outcome (AII-636)", async () => {
      const handle = buildHandle([entryFor(REPORT, okOutcome)]);

      // PR B (a different PR number) never ran a dry-run — must never receive PR A's verdict.
      await handle.reportDryRun({ repo: REPORT.repo, prNumber: 99, sha: "sha-for-pr-b" });
      expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
      expect(setCommitStatusFn).not.toHaveBeenCalled();

      // PR A's own report still works.
      await handle.reportDryRun(REPORT);
      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
    });

    it("reportDryRun() is a no-op when the stored outcome ran against a different sha", async () => {
      const handle = buildHandle([entryFor(REPORT, okOutcome)]);

      // A label applied after a new push superseded the stored outcome's sha.
      await handle.reportDryRun({ ...REPORT, sha: "a-newer-sha" });
      expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
      expect(setCommitStatusFn).not.toHaveBeenCalled();
    });

    it("reportDryRun() resolves true when it posts and false on a no-op (AII-636)", async () => {
      const handle = buildHandle([entryFor(REPORT, okOutcome)]);

      await expect(handle.reportDryRun(REPORT)).resolves.toBe(true);
      await expect(handle.reportDryRun({ repo: REPORT.repo, prNumber: 999, sha: "nope" })).resolves.toBe(false);
    });

    it("reportDryRun() logs a debug line and posts nothing when no outcome is stored for the PR", async () => {
      const handle = buildHandle();
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      try {
        await handle.reportDryRun({ repo: "TestOrg/test-kg", prNumber: 999, sha: "nope" });
        expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
        expect(setCommitStatusFn).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalledWith(
          "[kg-refresh] dry-run report skipped: no outcome for TestOrg/test-kg#999",
        );
      } finally {
        debugSpy.mockRestore();
      }
    });

    it("forgetPr() evicts a PR's stored outcome and persists the eviction (AII-636)", async () => {
      const handle = buildHandle([entryFor(REPORT, okOutcome)]);

      handle.forgetPr(REPORT.repo, REPORT.prNumber);

      expect(persistDryRunOutcomes).toHaveBeenCalledWith([]);
      await expect(handle.reportDryRun(REPORT)).resolves.toBe(false);
      expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
    });

    it("reportDryRun({ acceptBaseline: false }) reports plain-refusal wording, even for a PR the label was previously applied to (AII-640)", async () => {
      const handle = buildHandle([entryFor(REPORT, refusedOutcome)]);

      // Simulates the webhook's `unlabeled` branch: it always forces acceptBaseline:false.
      await handle.reportDryRun({ ...REPORT, acceptBaseline: false });

      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
      const body = postOrUpdateStickyCommentFn.mock.calls[0]![5] as string;
      expect(body).toContain("guard refused");
      expect(body).not.toContain("accepted by label");
      const statusCall = setCommitStatusFn.mock.calls[0] as [string, string, string, string, { state: string }];
      expect(statusCall[4].state).toBe("failure");
    });

    it("a wrong-shaped persisted blob (valid JSON, not an entry list) is ignored at boot instead of throwing", async () => {
      let handle: KgRefreshHandle | undefined;
      expect(() => { handle = buildHandle(({ not: "an array" }) as never); }).not.toThrow();

      await expect(handle!.reportDryRun(REPORT)).resolves.toBe(false);
      expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
    });

    it("a loader that throws is ignored at boot instead of aborting the handle", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const handle = buildHandle(() => { throw new Error("db locked"); });
        await expect(handle.reportDryRun(REPORT)).resolves.toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    describe("recordDryRunOutcome (AII-730)", () => {
      it("makes reportDryRun re-post for the same PR and sha, and persists the cache", async () => {
        const handle = buildHandle();

        handle.recordDryRunOutcome(REPORT, okOutcome);

        expect(persistDryRunOutcomes).toHaveBeenCalledWith([entryFor(REPORT, okOutcome)]);
        await expect(handle.reportDryRun(REPORT)).resolves.toBe(true);
        expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
        expect(setCommitStatusFn).toHaveBeenCalledTimes(1);
      });

      it("does not re-post for another PR or another sha", async () => {
        const handle = buildHandle();

        handle.recordDryRunOutcome(REPORT, okOutcome);

        await expect(handle.reportDryRun({ repo: REPORT.repo, prNumber: 99, sha: REPORT.sha })).resolves.toBe(false);
        await expect(handle.reportDryRun({ ...REPORT, sha: "a-newer-sha" })).resolves.toBe(false);
        expect(postOrUpdateStickyCommentFn).not.toHaveBeenCalled();
      });

      it("a newer outcome for the same PR replaces the older one", async () => {
        const handle = buildHandle();

        handle.recordDryRunOutcome(REPORT, okOutcome);
        handle.recordDryRunOutcome({ ...REPORT, sha: "newer" }, refusedOutcome);

        await expect(handle.reportDryRun(REPORT)).resolves.toBe(false);
        await expect(handle.reportDryRun({ ...REPORT, sha: "newer" })).resolves.toBe(true);
      });

      it("evicts the oldest PR past MAX_TRACKED_PRS", async () => {
        const handle = buildHandle();

        for (let n = 1; n <= MAX_TRACKED_PRS + 1; n++) {
          handle.recordDryRunOutcome({ ...REPORT, prNumber: n }, okOutcome);
        }

        await expect(handle.reportDryRun({ ...REPORT, prNumber: 1 })).resolves.toBe(false);
        await expect(handle.reportDryRun({ ...REPORT, prNumber: MAX_TRACKED_PRS + 1 })).resolves.toBe(true);
      });
    });
  });

  // ---- AII-585: credential preflight gate ----------------------------------------

  describe("preflight gate", () => {
    let probeRepo: ReturnType<typeof vi.fn>;
    let mintTokenPf: ReturnType<typeof vi.fn>;
    let fetchWorkflowFile: ReturnType<typeof vi.fn>;
    let fetchCompare: ReturnType<typeof vi.fn>;
    let preflightTarball: Buffer;

    // A claude-implement.yml body that declares run_config — the envelope contract, the happy
    // path (AII-654). Also declares runner_phase, matching every currently-synced template.
    const WORKFLOW_WITH_RUNNER_PHASE = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      run_config:",
      "        required: true",
      "      runner_phase:",
      "        required: false",
      "jobs:",
      "  implement:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
    ].join("\n");

    function buildPreflight() {
      // Build a fixture tarball whose sources.yml includes code_repo and a secondary repo.
      const pfRepo = mkdtempSync(join(tmpdir(), "kgpf-"));
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
      rmSync(pfRepo, { recursive: true, force: true });

      // mintTokenPf always succeeds; overrides can make specific calls fail.
      mintTokenPf = vi.fn(async () => ({ token: "tok", expiresAt: "" }));
      // probeRepo defaults to success; overrides can make specific slugs fail.
      probeRepo = vi.fn(async () => ({ ok: true, status: 200 }));
      // fetchWorkflowFile defaults to a workflow that accepts runner_phase; overrides can flip this.
      fetchWorkflowFile = vi.fn(async () => ({ status: 200, content: WORKFLOW_WITH_RUNNER_PHASE }));
      // fetchCompare defaults to no drift; overrides can flip this. Always mocked so these
      // tests never make a real network call to GitHub's compare API.
      fetchCompare = vi.fn(async () => ({ status: 200, behindBy: 0 }));
    }

    // ---- AII-594 / AII-654: workflow:envelope row -----------------------------------

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
      const pfRepo = mkdtempSync(join(tmpdir(), "kgpf-base-"));
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
      rmSync(pfRepo, { recursive: true, force: true });

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
  let dbPath: string;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = join(tmpdir(), `kg-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    idx = await import("../index.js");
    logMod = await import("../log.js");
    dedupMod = await import("../dedup.js");
    logMod.initLogTable();
    dedupMod.getDb().exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  });

  afterEach(() => {
    dedupMod.closeDb();
    rmSync(dbPath, { force: true });
  });

  const idle = { status: "accepted" as const, value: null };

  it("cancel resolves the triggerId from the KgRepo marker", async () => {
    const client = {
      repoStatus: vi.fn().mockResolvedValue({ status: "accepted", value: { triggerId: "t-1", startedAt: 1 } }),
      cancel: vi.fn().mockResolvedValue({ status: "accepted" }),
    };
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, vi.fn() as never);
    expect((await deps.cancel({ jobId: 1, reason: "operator_cancelled" })).status).toBe(200);
    expect(client.repoStatus).toHaveBeenCalledWith("Org/kg");
    expect(client.cancel).toHaveBeenCalledWith("t-1", "operator_cancelled");
  });

  it("cancel answers 409 with no marker and 503 when unavailable", async () => {
    const client = { repoStatus: vi.fn().mockResolvedValue(idle), cancel: vi.fn() };
    const deps = idx.makeKgRefreshAdminDeps("Org/kg", client as never, vi.fn() as never);
    expect(await deps.cancel({ jobId: 1, reason: "r" })).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
    client.repoStatus.mockResolvedValue({ status: "unavailable" });
    expect((await deps.cancel({ jobId: 1, reason: "r" })).status).toBe(503);
    expect(client.cancel).not.toHaveBeenCalled();
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
