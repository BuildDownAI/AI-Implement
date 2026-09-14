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

    it("rejects non-string token values without logging their contents", () => {
      const result = execute(JSON.stringify({ inputs: { run_token: { value: "private-sentinel" } } }));
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("private-sentinel");
    });
  });
}
