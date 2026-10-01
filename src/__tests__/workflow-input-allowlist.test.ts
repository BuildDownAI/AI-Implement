import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  INPUT_CONTRACT,
  checkInputs,
  checkDiagnostics,
  checkCopyDrift,
  type WorkflowKey,
} from "./helpers/workflow-input-contract.js";

describe("workflow input allowlist (ADR 032)", () => {
  for (const key of Object.keys(INPUT_CONTRACT) as WorkflowKey[]) {
    const c = INPUT_CONTRACT[key];
    const canonical = readFileSync(c.canonical, "utf-8");
    const synced = readFileSync(c.synced, "utf-8");

    it.each([c.canonical, c.synced])(`${key}: %s declares exactly the contract inputs, in order`, (file) => {
      expect(checkInputs(key, readFileSync(file, "utf-8"))).toEqual([]);
    });

    it(`${key}: every retained input has a documented reason`, () => {
      for (const reason of Object.values(c.inputs)) expect(reason.length).toBeGreaterThan(20);
    });

    it(`${key}: canonical and synced copies are byte-identical`, () => {
      expect(checkCopyDrift(canonical, synced)).toEqual([]);
    });

    it(`${key}: diagnostic and forwarding paths are credential-free`, () => {
      expect(checkDiagnostics(canonical)).toEqual([]);
    });
  }

  describe("negative fixtures", () => {
    const base = readFileSync(INPUT_CONTRACT.implement.canonical, "utf-8");

    it("rejects a dummy extra input (even when the count is swapped, not grown)", () => {
      const doc = parse(base) as any;
      doc.on.workflow_dispatch.inputs.dummy_extra = { type: "string", required: false };
      
      expect(checkInputs("implement", stringify(doc))).toEqual([
        expect.stringContaining('unauthorized input "dummy_extra" in implement'),
      ]);
      delete doc.on.workflow_dispatch.inputs.aws_region;
      expect(checkInputs("implement", stringify(doc)).length).toBe(2);
    });

    it("rejects a raw envelope echo, an unfiltered jq dump and shell tracing", () => {
      const doc = parse(base) as any;
      doc.jobs.implement.steps.push(
        { name: "Unsafe", env: { RUN_CONFIG: "${{ inputs.run_config }}" }, run: 'set -x\necho "$RUN_CONFIG"\nprintf \'%s\' "$RUN_CONFIG" | base64 -d | jq .\n' },
      );
      
      const found = checkDiagnostics(stringify(doc));
      expect(found).toEqual(expect.arrayContaining([
        expect.stringContaining("prints the raw envelope"),
        expect.stringContaining("unfiltered jq dump"),
        expect.stringContaining("shell tracing enabled"),
      ]));
    });

    it("rejects forwarding the envelope or a raw token input to an arbitrary env name", () => {
      const doc = parse(base) as any;
      doc.jobs.implement.steps.push({
        name: "Leaky",
        env: { SOMETHING: "${{ inputs.run_config }}", TOKEN: "${{ inputs.run_token }}", DUMP: "${{ toJSON(inputs) }}" },
        run: "true",
      });
      
      const found = checkDiagnostics(stringify(doc));
      expect(found).toEqual(expect.arrayContaining([
        expect.stringContaining("forwards the envelope as SOMETHING"),
        expect.stringContaining("forwards raw runner token input via TOKEN"),
        expect.stringContaining("serializes the dispatch payload"),
      ]));
    });

    it("rejects copy drift", () => {
      expect(checkCopyDrift(base, base + "\n# drift\n")).toEqual(["synced copy differs from canonical template"]);
    });
  });
});
