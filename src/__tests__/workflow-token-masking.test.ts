import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

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

    it("masks the encoded envelope first, then every extracted credential, including nested grant leaves", () => {
      const run_config = enc({ ...base, credentials: { version: 1, ...sentinels,
        modelAuthGrant: { nested: { bearer: "AII982-grant-leaf-sentinel" }, short: "x" } } });
      const result = execute(JSON.stringify({ inputs: { run_config } }));
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines.every((l) => l.startsWith("::add-mask::"))).toBe(true);
      expect(lines[0]).toBe(`::add-mask::${run_config}`);
      for (const v of [...Object.values(sentinels), "AII982-grant-leaf-sentinel"]) {
        expect(lines).toContain(`::add-mask::${v}`);
      }
      expect(result.stdout).not.toContain("::add-mask::x\n");
      expect(result.stderr).toBe("");
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

    it("contains no raw or decoded envelope dump", () => {
      expect(print.run).not.toMatch(/jq \.(\s|$)/);
      expect(print.run).not.toMatch(/echo[^\n]*\$RUN_CONFIG/);
    });
  });
}
