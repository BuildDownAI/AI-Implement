// Guard for ADR 034 rule 4 (each producer has a contract test). Default suite, no Docker: every
// promise a Restate workflow waits on needs a default-suite test titled `contract: <Workflow>.<promise>`.
// A scenario in src/__tests__/restate/ resolves promises from the test body, so it is not a producer
// proof and is not read. There is deliberately no allowlist: that is where a missing sender hides.
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const RESTATE_SRC_DIR = join(import.meta.dirname, "..", "restate");
const TESTS_DIR = import.meta.dirname;
const SELF = "restate-producer-guard.test.ts";

/** `<Workflow>.<promise>` pairs declared in one source file, deduplicated. */
export function findPromisePairs(source: string): string[] {
  const workflow = /restate\.workflow\(\s*\{\s*name:\s*"(\w+)"/.exec(source)?.[1];
  if (!workflow) return [];
  const names = [...source.matchAll(/ctx\.promise(?:<[^>]*>)?\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
  return [...new Set(names)].map((name) => `${workflow}.${name}`);
}

/** `<Workflow>.<promise>` pairs named by `contract: ` test titles in one test file. */
export function findContractTitles(source: string): string[] {
  return [...source.matchAll(/\b(?:it|test)\(\s*["'`]contract: (\w+)\.(\w+)\b/g)].map((m) => `${m[1]}.${m[2]}`);
}

/** One line per promise in `source` with no matching contract title. */
export function findMissingContracts(file: string, source: string, titles: string[]): string[] {
  const have = new Set(titles);
  return findPromisePairs(source)
    .filter((pair) => !have.has(pair))
    .map((pair) => `${file}: ${pair} has no "contract: ${pair}" test`);
}

describe("restate producer guard (ADR 034 rule 4)", () => {
  const sources = readdirSync(RESTATE_SRC_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: `src/restate/${f}`, source: readFileSync(join(RESTATE_SRC_DIR, f), "utf8") }));
  const titles = readdirSync(TESTS_DIR, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(sep).join("/"))
    .filter((f) => f.endsWith(".test.ts") && f !== SELF && !f.startsWith("restate/"))
    .flatMap((f) => findContractTitles(readFileSync(join(TESTS_DIR, f), "utf8")));

  it("finds the promises that exist today", () => {
    const pairs = sources.flatMap((s) => findPromisePairs(s.source)).sort();
    expect(pairs).toEqual([
      "KgRefresh.cancel", "KgRefresh.progress", "KgRefresh.report", "ReviewFixAttempt.cancel", "ReviewFixAttempt.wake",
    ]);
  });

  it("every workflow promise has a contract test", () => {
    expect(sources.flatMap((s) => findMissingContracts(s.file, s.source, titles))).toEqual([]);
  });

  it("the scanner flags a promise with no contract title", () => {
    const src = [
      "return restate.workflow({",
      '  name: "Demo",',
      "  handlers: {},",
      "});",
      'const a = ctx.promise<boolean>("alpha");',
      'const a2 = ctx.promise<boolean>("alpha");',
      'const b = ctx.promise("beta");',
      'objectSendClient({ name: "Other" });',
    ].join("\n");
    const title = ["contract:", "Demo.alpha — covered"].join(" ");
    const titleSource = `it("${title}", () => {});`;
    expect(findMissingContracts("x.ts", src, findContractTitles(titleSource))).toEqual([
      'x.ts: Demo.beta has no "contract: Demo.beta" test',
    ]);
  });
});
