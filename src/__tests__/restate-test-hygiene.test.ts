// Guard for the timing rules in docs/restate-testing.md § Timing rules (AII-993). Default
// suite, no Docker: scans the Restate scenario sources for the patterns that caused timing
// flakes — raw sleeps, direct admin `/query` reads, and per-file poll helpers.
// It also guards Restate-tier membership.
// A scenario gets that tier's config (allowlist, timeouts) only when it is named *.restate.test.ts under restate/.
// A misnamed or misplaced one runs under the wrong config, or never runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { eventually } from "./restate/harness.js";
import * as harnessExports from "./restate/harness.js";
import * as binaryEnvironmentExports from "./restate/binary-environment.js";

const RESTATE_DIR = join(import.meta.dirname, "restate");
const MARKER = "restate-test-allow:";

/** Files this guard does not cover yet, each with the reason. A rename must update this list. */
const ALLOWLISTED_FILES: Record<string, string> = {
  "endpoint-registration.restate.test.ts": "shared-service test, out of scope by operator decision 2026-09-30",
  "endpoint.restate.test.ts": "shared-service test, out of scope by operator decision 2026-09-30",
  "operator-object.restate.test.ts": "shared-service test, out of scope by operator decision 2026-09-30",
  "tools.restate.test.ts": "shared-service test, out of scope by operator decision 2026-09-30",
  "review-fix-attempt.restate.test.ts": "review-fix pilot test, out of scope by operator decision 2026-09-30",
  "review-fix-pr.restate.test.ts": "review-fix pilot test, out of scope by operator decision 2026-09-30",
  "review-fix-pilot.restate.test.ts": "review-fix pilot test, out of scope by operator decision 2026-09-30",
};

/** Violations in one file's source, as `file:line: message`. */
export function findViolations(file: string, source: string): string[] {
  const lines = source.split("\n");
  const allowed = (i: number) => lines[i].includes(MARKER) || (i > 0 && lines[i - 1].includes(MARKER));
  const out: string[] = [];
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    if (line.includes("setTimeout(") && !allowed(i)) {
      out.push(`${at}: raw setTimeout( — use eventually() or settle(), or mark it // ${MARKER} <reason>`);
    }
    // A direct admin read: `/query` on a fetch( line or in the two lines after it (a multi-line call).
    const inFetch = [i, i - 1, i - 2].some((j) => j >= 0 && lines[j].includes("fetch(")) && line.includes("/query");
    if (inFetch && !allowed(i)) {
      out.push(`${at}: direct admin /query fetch — use eventually(() => queryInvocations(...), ...)`);
    }
    if (/function until(Async)?\b|const until\s*=/.test(line)) {
      out.push(`${at}: local poll helper — use eventually() from harness.ts`);
    }
  });
  return out;
}

describe("restate scenario hygiene (AII-993)", () => {
  const files = readdirSync(RESTATE_DIR).filter((f) => f.endsWith(".restate.test.ts"));

  it("every allowlisted file exists", () => {
    for (const name of Object.keys(ALLOWLISTED_FILES)) {
      expect(existsSync(join(RESTATE_DIR, name)), `${name} is allowlisted but missing`).toBe(true);
    }
  });

  it("every non-allowlisted scenario file is clean", () => {
    const violations = files
      .filter((f) => !(f in ALLOWLISTED_FILES))
      .flatMap((f) => findViolations(`src/__tests__/restate/${f}`, readFileSync(join(RESTATE_DIR, f), "utf8")));
    expect(violations).toEqual([]);
  });

  it("the scanner flags each forbidden pattern with file and line", () => {
    const src = [
      "await new Promise((r) => setTimeout(r, 5));",
      "// restate-test-allow: fake",
      "setTimeout(() => {}, 1);",
      "const response = await fetch(`${admin}/query`, {});",
      "async function until(p) {}",
      "const untilAsync = 1; const until = () => 1;",
    ].join("\n");
    const found = findViolations("x.restate.test.ts", src);
    expect(found.map((v) => v.split(":").slice(0, 2).join(":"))).toEqual([
      "x.restate.test.ts:1", "x.restate.test.ts:4", "x.restate.test.ts:5", "x.restate.test.ts:6",
    ]);
  });
});

describe("restate tier membership", () => {
  const SRC_DIR = join(import.meta.dirname, "..");
  // Each of these starts a Restate engine; `eventually` and the other harness helpers do not.
  const ENGINE_STARTERS = /\b(startVariants|startRetryEnabled|startBinaryEnvironment|RestateTestEnvironment|RestateContainer)\b/;

  it("every test file under restate/ is named *.restate.test.ts", () => {
    const misnamed = readdirSync(RESTATE_DIR).filter((f) => f.endsWith(".test.ts") && !f.endsWith(".restate.test.ts"));
    expect(misnamed, "Neither vitest config collects these; rename each to *.restate.test.ts").toEqual([]);
  });

  it("no test file outside restate/ starts a Restate engine", () => {
    const restatePrefix = relative(SRC_DIR, RESTATE_DIR) + sep;
    const offenders = (readdirSync(SRC_DIR, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".test.ts") && !f.startsWith(restatePrefix))
      .filter((f) => join(SRC_DIR, f) !== import.meta.filename)
      .filter((f) => ENGINE_STARTERS.test(readFileSync(join(SRC_DIR, f), "utf8")));
    expect(
      offenders,
      "The default suite collects these, so they run without the Restate tier's allowlist and timeouts; " +
        "move each under src/__tests__/restate/ as *.restate.test.ts",
    ).toEqual([]);
  });

  it("ENGINE_STARTERS names every start function the harness exports", () => {
    const exported = [...Object.keys(harnessExports), ...Object.keys(binaryEnvironmentExports)];
    const unlisted = exported.filter((name) => name.startsWith("start") && !ENGINE_STARTERS.test(name));
    expect(unlisted, "Add each to ENGINE_STARTERS, or the check above cannot see a test that calls it").toEqual([]);
  });
});

describe("eventually", () => {
  it("returns the accepted value", async () => {
    let n = 0;
    expect(await eventually(() => ++n, (v) => v >= 3, { intervalMs: 1 })).toBe(3);
  });

  it("on timeout names the label and prints the last value read", async () => {
    await expect(
      eventually(() => ({ rows: 2 }), (v) => v.rows === 3, { timeoutMs: 50, intervalMs: 5, label: "three rows" }),
    ).rejects.toThrow(/three rows.*\{"rows":2\}/);
  });
});
