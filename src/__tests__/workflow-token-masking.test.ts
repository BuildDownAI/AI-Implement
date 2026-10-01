import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { validateResolvedAgentSnapshot, validateRunCredentials } from "../run-config.js";

const files = [
  "workflows/claude-implement.yml",
  ".github/workflows/claude-implement.yml",
  "workflows/claude-plan.yml",
  ".github/workflows/claude-plan.yml",
];

for (const file of files) {
  describe(`${file} callback-token bootstrap`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    const job = workflow.jobs.implement ?? workflow.jobs.plan;
    const mask = job.steps.find((step: { name: string }) => step.name === "Mask runner callback tokens");

    function execute(event: string | undefined) {
      const dir = mkdtempSync(join(tmpdir(), "mask-event-"));
      const eventPath = join(dir, "event.json");
      if (event !== undefined) writeFileSync(eventPath, event);
      try {
        return spawnSync("sh", ["-e", "-c", mask.run], {
          // Deliberately do not inherit any live runner credentials.
          env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath },
          encoding: "utf8",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("registers masks before any step header can expose a callback input", () => {
      expect(job.steps[0]).toBe(mask);
      expect(mask.env).toBeUndefined();
      expect(JSON.stringify(mask)).not.toContain("${{");
      // Later env mappings are permitted only after the bootstrap registered masks.
      expect(job.env).toBeUndefined();
      expect(workflow.env).toBeUndefined();
    });

    it("reads and masks every callback credential from the event file", () => {
      const tokens = {
        run_token: "AII676-result-sentinel",
        run_progress_token: "AII676-progress-sentinel",
        ...(workflow.on.workflow_dispatch.inputs.run_publication_token
          ? { run_publication_token: "AII676-publication-sentinel" }
          : {}),
      };
      const result = execute(JSON.stringify({ inputs: tokens }));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toEqual(
        Object.values(tokens).map((value) => `::add-mask::${value}`),
      );
    });

    it("skips missing and empty optional tokens without emitting empty masks", () => {
      for (const inputs of [{}, { run_token: "", run_progress_token: null }]) {
        const result = execute(JSON.stringify({ inputs }));
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      }
    });

    it("escapes command delimiters so one value cannot inject a workflow command", () => {
      const result = execute(JSON.stringify({ inputs: { run_token: "sentinel%\r\n::warning::not-a-command" } }));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("::add-mask::sentinel%25%0D%0A::warning::not-a-command\n");
    });

    it("fails closed on a missing or malformed event before credential consumers run", () => {
      for (const event of [undefined, "{"]) {
        const result = execute(event);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
      }
    });

    const enc = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
    const base = { v: 1, issue: { id: "i", identifier: "AII-982", title: "t", description: "d" } };
    const sentinels = {
      resultToken: "AII982-result-sentinel",
      progressToken: "AII982-progress-sentinel",
      publicationToken: "AII982-publication-sentinel",
      attemptToken: "AII982-attempt-sentinel",
    };

    const plainGrant = {
      version: 1, audience: "model-auth", grantId: "grant-1", dispatchId: "dispatch-1", snapshotId: "snap-1",
      projectKey: "proj", backend: "gha", expiresAt: 1_800_000_000_000,
      bearer: "AII982-grant-bearer-" + "A".repeat(32),
      bindings: [
        { stage: "planning", profileId: "prof-api", profileRevision: 2, authMode: "openai-api-key" },
        { stage: "implementation", profileId: "prof-sub", profileRevision: 1, authMode: "codex-subscription", ownerGeneration: 3 },
      ],
    };
    const sealedGrant = {
      version: 1, algorithm: "aes-256-gcm", dispatchId: "dispatch-1", backend: "fly",
      nonce: "N".repeat(16), ciphertext: "AII982sealedcipher", tag: "T".repeat(22),
    };
    const profile = (agent: string, provider: string, authMode: string) =>
      ({ id: "prof-1", identity: "ident", revision: 1, agent, provider, authMode });
    const snapshot = {
      version: 1, snapshotId: "snap-1",
      configRevisions: {
        orchestratorDefault: { configRevisionId: "cfg-a", revision: 1 },
        project: { configRevisionId: "cfg-b", revision: 2 },
      },
      stages: Object.fromEntries(["planning", "implementation", "review"].map((st) => [st,
        { agent: "claude", provider: "anthropic", model: "m", accountProfileId: "prof-1", invocationTimeoutMs: 1000 }])),
      sources: Object.fromEntries(["planning", "implementation", "review"].map((st) => [st,
        { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" }])),
      profiles: Object.fromEntries(["planning", "implementation", "review"].map((st) =>
        [st, profile("claude", "anthropic", "anthropic-api-key")])),
    };
    const maskLines = (stdout: string) => stdout.trim().split("\n");

    it("fixtures satisfy the authoritative TypeScript contract", () => {
      expect(() => validateRunCredentials({ version: 1, ...sentinels, modelAuthGrant: plainGrant })).not.toThrow();
      expect(() => validateRunCredentials({ version: 1, modelAuthGrant: sealedGrant })).not.toThrow();
      expect(() => validateResolvedAgentSnapshot(snapshot)).not.toThrow();
    });

    it("masks the encoded envelope first, then every token and the plain grant bearer", () => {
      const run_config = enc({ ...base, agentConfig: snapshot, credentials: { version: 1, ...sentinels, modelAuthGrant: plainGrant } });
      const result = execute(JSON.stringify({ inputs: { run_config } }));
      expect(result.status).toBe(0);
      const lines = maskLines(result.stdout);
      expect(lines.every((l) => l.startsWith("::add-mask::"))).toBe(true);
      expect(lines[0]).toBe(`::add-mask::${run_config}`);
      for (const v of [...Object.values(sentinels), plainGrant.bearer]) expect(lines).toContain(`::add-mask::${v}`);
      expect(result.stdout).not.toContain(plainGrant.projectKey + "\n");
      expect(result.stderr).toBe("");
    });

    it("masks the sealed grant ciphertext, nonce and tag", () => {
      const run_config = enc({ ...base, credentials: { version: 1, modelAuthGrant: sealedGrant } });
      const result = execute(JSON.stringify({ inputs: { run_config } }));
      expect(result.status).toBe(0);
      const lines = maskLines(result.stdout);
      expect(lines[0]).toBe(`::add-mask::${run_config}`);
      for (const v of [sealedGrant.ciphertext, sealedGrant.nonce, sealedGrant.tag]) expect(lines).toContain(`::add-mask::${v}`);
    });

    it("accepts a legacy envelope without credentials", () => {
      const run_config = enc(base);
      const result = execute(JSON.stringify({ inputs: { run_config, run_token: "AII982-legacy" } }));
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([`::add-mask::AII982-legacy`, `::add-mask::${run_config}`]);
    });

    it("fails closed on malformed private data without echoing it", () => {
      const bad: unknown[] = [
        "!!not-base64!!",
        Buffer.from("not json AII982-leak").toString("base64"),
        enc({ ...base, credentials: { version: 1, resultToken: 42 } }),
        enc({ ...base, credentials: { version: 1, AII982leakkey: "AII982-leak-value" } }),
        enc({ ...base, credentials: { version: 2, resultToken: "AII982-leak-value" } }),
        enc({ ...base, credentials: { version: 1, resultToken: "has space AII982-leak" } }),
        enc({ ...base, credentials: "AII982-leak-value" }),
        { not: "a string" },
        enc({ ...base, credentials: null }),
        enc({ ...base, credentials: { version: 1, resultToken: null } }),
        enc({ ...base, credentials: { version: 1, modelAuthGrant: null } }),
        enc({ ...base, credentials: { version: 1, modelAuthGrant: { nested: { bearer: "AII982-invalid-grant-secret" } } } }),
        enc({ ...base, agentConfig: null }),
        enc({ ...base, agentConfig: { version: 1, modelAuthGrant: "AII982-agentconfig-secret" } }),
      ];
      for (const run_config of bad) {
        const result = execute(JSON.stringify({ inputs: { run_config } }));
        expect(result.status).not.toBe(0);
        const out = result.stdout.replace(/^::add-mask::.*$/gm, "");
        expect(out + result.stderr).not.toMatch(/AII982/);
        expect(result.stderr).not.toContain(String(run_config));
        expect(result.stderr).toContain("Private run_config bootstrap failed");
      }
    });

    it("rejects every malformed grant variant exactly as the typed contract does", () => {
      const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
      const mut = (g: Record<string, any>, fn: (g: Record<string, any>) => void) => { const c = clone(g); fn(c); return c; };
      const variants: unknown[] = [
        mut(plainGrant, (g) => { g.audience = "progress"; }),
        mut(plainGrant, (g) => { g.version = 2; }),
        mut(plainGrant, (g) => { g.extra = "AII982-extra"; }),
        mut(plainGrant, (g) => { g.bearer = "short"; }),
        mut(plainGrant, (g) => { g.bearer = "AII982 bad chars " + "A".repeat(32); }),
        mut(plainGrant, (g) => { g.backend = "k8s"; }),
        mut(plainGrant, (g) => { g.dispatchId = "bad id!"; }),
        mut(plainGrant, (g) => { g.expiresAt = 0; }),
        mut(plainGrant, (g) => { g.expiresAt = 1.5; }),
        mut(plainGrant, (g) => { g.bindings = []; }),
        mut(plainGrant, (g) => { g.bindings = "AII982-not-an-array"; }),
        mut(plainGrant, (g) => { g.bindings[0].stage = "deploy"; }),
        mut(plainGrant, (g) => { g.bindings[0].authMode = "oauth"; }),
        mut(plainGrant, (g) => { g.bindings[0].ownerGeneration = 1; }),
        mut(plainGrant, (g) => { delete g.bindings[1].ownerGeneration; }),
        mut(plainGrant, (g) => { g.bindings[0].profileRevision = 0; }),
        mut(plainGrant, (g) => { g.bindings[0].key = "AII982-binding-key"; }),
        mut(plainGrant, (g) => { g.bindings.push(clone(g.bindings[0])); }),
        mut(plainGrant, (g) => { g.bindings[1].profileId = "prof-api"; }),
        mut(plainGrant, (g) => { g.dispatchId = "ok\n"; }),
        mut(sealedGrant, (g) => { g.bearer = "AII982-sealed-extra"; }),
        mut(sealedGrant, (g) => { g.algorithm = "none"; }),
        mut(sealedGrant, (g) => { g.backend = "gha"; }),
        mut(sealedGrant, (g) => { g.nonce = "short"; }),
        mut(sealedGrant, (g) => { g.tag = "B".repeat(21); }),
        mut(sealedGrant, (g) => { g.ciphertext = "not base64!"; }),
        mut(sealedGrant, (g) => { g.ciphertext = "A".repeat(70000); }),
        { nested: { bearer: "AII982-invalid-grant-secret" } },
        "AII982-string-grant",
        [plainGrant],
        null,
      ];
      for (const modelAuthGrant of variants) {
        const credentials = { version: 1, modelAuthGrant };
        expect(() => validateRunCredentials(credentials)).toThrow();
        const result = execute(JSON.stringify({ inputs: { run_config: enc({ ...base, credentials }) } }));
        expect(result.status).not.toBe(0);
        expect(result.stdout.replace(/^::add-mask::.*$/gm, "")).not.toMatch(/AII982/);
        expect(result.stderr).toBe("::error::Private run_config bootstrap failed\n");
      }
    });

    it("rejects every malformed agentConfig variant exactly as the typed contract does", () => {
      const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
      const mut = (fn: (c: Record<string, any>) => void) => { const c = clone(snapshot) as Record<string, any>; fn(c); return c; };
      const variants: unknown[] = [
        mut((c) => { c.modelAuthGrant = "AII982-agentconfig-secret"; }),
        mut((c) => { c.version = 2; }),
        mut((c) => { delete c.snapshotId; }),
        mut((c) => { c.configRevisions.project.revision = 0; }),
        mut((c) => { c.configRevisions.extra = "AII982"; }),
        mut((c) => { delete c.stages.review; }),
        mut((c) => { c.stages.extra = c.stages.review; }),
        mut((c) => { c.stages.planning.provider = "openai"; }),
        mut((c) => { c.stages.planning.invocationTimeoutMs = "1000"; }),
        mut((c) => { c.stages.planning.token = "AII982"; }),
        mut((c) => { c.sources.planning.model = "elsewhere"; }),
        mut((c) => { c.profiles.planning.id = "other"; }),
        mut((c) => { c.profiles.planning.authMode = "codex-subscription"; }),
        mut((c) => { c.profiles.planning.secret = "AII982"; }),
        "AII982-string-config",
        [snapshot],
      ];
      for (const agentConfig of variants) {
        expect(() => validateResolvedAgentSnapshot(agentConfig)).toThrow();
        const result = execute(JSON.stringify({ inputs: { run_config: enc({ ...base, agentConfig }) } }));
        expect(result.status).not.toBe(0);
        expect(result.stdout.replace(/^::add-mask::.*$/gm, "")).not.toMatch(/AII982/);
        expect(result.stderr).toBe("::error::Private run_config bootstrap failed\n");
      }
    });

    it("never traces or dumps the envelope", () => {
      expect(mask.run).not.toMatch(/set -[a-z]*x/);
      expect(mask.run).toContain("set +x");
    });

    it("rejects non-string token values without logging their contents", () => {
      const result = execute(JSON.stringify({ inputs: { run_token: { value: "private-sentinel" } } }));
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("private-sentinel");
    });
  });
}

for (const file of files.slice(0, 2)) {
  describe(`${file} review-fix correlation`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    const steps = workflow.jobs.implement.steps;
    const validate = steps.find((step: { name: string }) => step.name === "Validate attempt correlation");

    function execute(reviewFix: unknown, attemptToken: string) {
      const config = { v: 1, issue: { id: "issue-1", identifier: "AII-782", title: "test", description: "" },
        ...(reviewFix === undefined ? {} : { reviewFix }) };
      return spawnSync("sh", ["-e", "-c", validate.run], {
        env: {
          PATH: process.env.PATH,
          RUN_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64"),
          RUN_ATTEMPT_TOKEN: attemptToken,
        },
        encoding: "utf8",
      });
    }

    const valid = { version: 1, attemptId: "attempt-782", installationId: 12,
      repository: "BuildDownAI/AI-Implement", prNumber: 42, deadlineAt: 1_800_000_000_000 };

    it("accepts legacy dispatches and exact pilot identity before exposing the envelope", () => {
      expect(execute(undefined, "").status).toBe(0);
      expect(execute(valid, valid.attemptId).status).toBe(0);
      expect(steps.indexOf(validate)).toBeGreaterThan(0);
      expect(steps.indexOf(validate)).toBeLessThan(steps.findIndex((step: { name: string }) => step.name === "Print dispatch inputs"));
    });

    it("rejects mismatched, malformed, and unsupported pilot markers without echoing their contents", () => {
      for (const [metadata, token] of [
        [valid, "other-attempt"], [undefined, "attempt-782"],
        [{ ...valid, attemptId: "attempt-782; echo private-sentinel" }, "attempt-782"],
        [{ ...valid, version: 2 }, "attempt-782"],
        [{ ...valid, deadlineAt: "tomorrow" }, "attempt-782"],
      ] as const) {
        const result = execute(metadata, token);
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("private-sentinel");
        expect(result.stderr).not.toContain("private-sentinel");
      }
    });
  });
}

for (const file of files) {
  describe(`${file} print step diagnostic projection`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    const job = workflow.jobs.implement ?? workflow.jobs.plan;
    const print = job.steps.find((step: { name: string }) => step.name === "Print dispatch inputs");

    it("prints only the credential-free projection with credential field names", () => {
      const run_config = Buffer.from(JSON.stringify({
        v: 1, issue: { id: "i", identifier: "AII-982", title: "t", description: "d" },
        unknownKey: "AII982-unknown-sentinel",
        credentials: { version: 1, resultToken: "AII982-result-sentinel", modelAuthGrant: { bearer: "AII982-grant-sentinel" } },
      })).toString("base64");
      const result = spawnSync("sh", ["-e", "-c", print.run], {
        env: { PATH: process.env.PATH, RUN_CONFIG: run_config, HAS_RUN_TOKEN: "true", HAS_RUN_PROGRESS_TOKEN: "false", HAS_PUBLICATION_TOKEN: "false" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/AII982/);
      expect(result.stdout).not.toContain(run_config);
      expect(result.stdout).toContain('"credentialFields"');
      expect(result.stdout).toContain('"resultToken"');
      expect(result.stdout).toContain('"modelAuthGrant"');
    });

    it("omits agentConfig, valid or not, so a nested authoritative config can never print", () => {
      const sentinel = "AII982-agentconfig-secret";
      for (const agentConfig of [{ version: 1, modelAuthGrant: sentinel }, { version: 1, snapshotId: sentinel }]) {
        const run_config = Buffer.from(JSON.stringify({
          v: 1, issue: { id: "i", identifier: "AII-982", title: "t", description: "d" }, agentConfig,
        })).toString("base64");
        const result = spawnSync("sh", ["-e", "-c", print.run], {
          env: { PATH: process.env.PATH, RUN_CONFIG: run_config, HAS_RUN_TOKEN: "false", HAS_RUN_PROGRESS_TOKEN: "false", HAS_PUBLICATION_TOKEN: "false" },
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain(sentinel);
        expect(result.stdout).toContain('"agentConfig": "<omitted>"');
      }
    });

    it("contains no raw or decoded envelope dump", () => {
      expect(print.run).not.toMatch(/jq \.(\s|$)/);
      expect(print.run).not.toMatch(/echo[^\n]*\$RUN_CONFIG/);
    });
  });
}

for (const file of files) {
  const isPlan = file.endsWith("claude-plan.yml");
  describe(`${file} private credential handoff (AII-1000)`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    const job = workflow.jobs.implement ?? workflow.jobs.plan;
    const mask = job.steps.find((step: { name: string }) => step.name === "Mask runner callback tokens");
    const run = job.steps.find((step: { name: string }) => step.name === "Run pipeline" || step.name === "Run planning");
    const enc = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
    const base = { v: 1, issue: { id: "i", identifier: "AII-1000", title: "t", description: "d" } };

    // Runs the bootstrap step, then the Run step against a stub entrypoint that dumps its env.
    function handoff(inputs: Record<string, unknown>) {
      const dir = mkdtempSync(join(tmpdir(), "handoff-"));
      try {
        const eventPath = join(dir, "event.json");
        const envPath = join(dir, "github.env");
        const outPath = join(dir, "github.output");
        const dump = join(dir, "env.json");
        const stub = join(dir, "entrypoint.sh");
        writeFileSync(eventPath, JSON.stringify({ inputs }));
        writeFileSync(envPath, "");
        writeFileSync(outPath, "");
        writeFileSync(stub, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' "${dump}"\n`, { mode: 0o755 });
        const boot = spawnSync("sh", ["-e", "-c", mask.run], {
          env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_ENV: envPath, GITHUB_OUTPUT: outPath },
          encoding: "utf8",
        });
        if (boot.status !== 0) return { boot, env: undefined, githubEnv: readFileSync(envPath, "utf8"), outputs: readFileSync(outPath, "utf8") };
        // Nothing may reach later steps through $GITHUB_ENV; credentials are step outputs.
        const githubEnv = readFileSync(envPath, "utf8");
        // Parse the $GITHUB_OUTPUT heredoc format the way the Actions runner does.
        const lines = readFileSync(outPath, "utf8").split("\n");
        const outputs: Record<string, string> = {};
        for (let i = 0; i < lines.length; i++) {
          const m = /^([a-z_]+)<<(.+)$/.exec(lines[i]);
          if (!m) continue;
          const end = lines.indexOf(m[2], i + 1);
          outputs[m[1]] = lines.slice(i + 1, end).join("\n");
          i = end;
        }
        // Resolve the Run step's env: only bootstrap outputs are expressible; skip other expressions.
        const stepEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(run.env ?? {})) {
          if (typeof v !== "string") continue;
          const o = /^\$\{\{\s*steps\.bootstrap\.outputs\.(\w+)\s*\}\}$/.exec(v);
          if (o) stepEnv[k] = outputs[o[1]] ?? "";
          else if (!v.includes("${{")) stepEnv[k] = v;
        }
        const done = spawnSync("sh", ["-e", "-c", run.run.replace("/opt/ai-implement/entrypoint.sh", stub)], {
          env: { PATH: process.env.PATH, ...stepEnv },
          encoding: "utf8",
        });
        const env = done.status === 0 ? JSON.parse(readFileSync(dump, "utf8")) : undefined;
        return { boot, done, env, githubEnv, outputs };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const tokens = { resultToken: "res-$(touch${IFS}/tmp/pwn1000)-`x`-%0A-\"'-<<EOF", progressToken: "prog_%25_$HOME_\\n", publicationToken: "pub-sentinel-1000" };

    it("delivers private credentials with empty public inputs and keeps grants out of env", () => {
      const run_config = enc({ ...base, credentials: { version: 1, ...tokens, attemptToken: "att-1" } });
      const r = handoff({ run_config, run_token: "", run_progress_token: "", run_attempt_token: "att-1" });
      expect(r.boot.status).toBe(0);
      expect(r.env.RUN_TOKEN).toBe(tokens.resultToken);
      expect(r.env.RUN_PROGRESS_TOKEN).toBe(tokens.progressToken);
      expect(r.env.RUN_PUBLICATION_TOKEN).toBe(isPlan ? undefined : tokens.publicationToken);
      expect(JSON.stringify(r.env)).not.toContain("att-1");
      expect(r.boot.stderr).toBe("");
      // Credentials never enter $GITHUB_ENV, which every later step (incl. third-party actions) inherits.
      expect(r.githubEnv).toBe("");
    });

    it("maps credentials only into the Run step env, not any other step", () => {
      const idx = job.steps.indexOf(mask);
      for (const step of job.steps) {
        if (step === run || step === mask) continue;
        expect(JSON.stringify(step)).not.toMatch(/steps\.bootstrap\.outputs|\bRUN_(PROGRESS_|PUBLICATION_)?TOKEN\b/);
      }
      expect(job.steps.indexOf(run)).toBeGreaterThan(idx);
      expect(mask.run).not.toMatch(/>>\s*"?\$\{?GITHUB_ENV/);
    });

    it("lets the private namespace win over conflicting public values and never backfills", () => {
      const run_config = enc({ ...base, credentials: { version: 1, resultToken: "private-result" } });
      const r = handoff({ run_config, run_token: "public-result", run_progress_token: "public-progress", run_publication_token: "public-pub" });
      expect(r.env.RUN_TOKEN).toBe("private-result");
      expect(r.env.RUN_PROGRESS_TOKEN).toBe("");
      expect(r.env.RUN_PUBLICATION_TOKEN ?? "").toBe("");
    });

    it("never prints the delivered values outside the mask commands", () => {
      const run_config = enc({ ...base, credentials: { version: 1, ...tokens } });
      const r = handoff({ run_config });
      const unmasked = r.boot.stdout.split("\n").filter((l: string) => !l.startsWith("::add-mask::")).join("\n");
      for (const v of Object.values(tokens)) {
        expect(unmasked).not.toContain(v);
        expect(r.boot.stderr).not.toContain(v);
      }
    });

    it("keeps legacy inputs when no private namespace exists", () => {
      const r = handoff({ run_config: enc(base), run_token: "legacy-r", run_progress_token: "legacy-p", run_publication_token: "legacy-u" });
      expect(r.env.RUN_TOKEN).toBe("legacy-r");
      expect(r.env.RUN_PROGRESS_TOKEN).toBe("legacy-p");
      expect(r.env.RUN_PUBLICATION_TOKEN).toBe(isPlan ? undefined : "legacy-u");
    });

    it("fails before the entrypoint on malformed private data without echoing it", () => {
      const bad = [
        "!!not-base64!!",
        enc({ ...base, credentials: { version: 1, resultToken: "has white space" } }),
        enc({ ...base, credentials: { version: 1, resultToken: 5 } }),
        enc({ ...base, credentials: { version: 1, bogus: "SECRET-SENTINEL" } }),
        enc({ ...base, credentials: { version: 1, modelAuthGrant: { version: 1, bearer: "SECRET-SENTINEL" } } }),
      ];
      for (const run_config of bad) {
        const r = handoff({ run_config, run_token: "public" });
        expect(r.boot.status).not.toBe(0);
        expect(r.env).toBeUndefined();
        expect(r.githubEnv).toBe("");
        expect(r.outputs).toBe("");
        expect(r.boot.stderr).toContain("Private run_config bootstrap failed");
        expect(r.boot.stdout + r.boot.stderr).not.toContain("SECRET-SENTINEL");
      }
    });
  });
}
