import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSourceResults } from "../kg-source-results.js";

/** Golden files written by a real KGB ingest (see fixtures/kgb-source-results/README.md). */
function parseGolden(name: string) {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/kgb-source-results/${name}.json`, import.meta.url)), "utf8");
  return parseSourceResults(JSON.parse(text));
}

const brief = (rows: ReturnType<typeof parseGolden>) => rows.map((r) => [r.source, r.status]);

const CODE_REPO = ["code_repo:your-org/your-project", "success"];

describe("parseSourceResults on the KGB golden source-results.json files", () => {
  it("success.json: ids and statuses in order, tracker counts kept", () => {
    const rows = parseGolden("success");
    expect(brief(rows)).toEqual([
      CODE_REPO,
      ["docs_site:*", "skipped"],
      ["tracker:AII", "success"],
      ["self:*", "skipped"],
    ]);
    expect(rows[2]).toMatchObject({ kind: "tracker", counts: { issues: 2 } });
  });

  it("skipped.json: ids and statuses in order, and the skipped reason", () => {
    const rows = parseGolden("skipped");
    expect(brief(rows)).toEqual([
      CODE_REPO,
      ["docs_site:https://docs.example.com", "skipped"],
      ["self:*", "skipped"],
    ]);
    expect(rows[1].reason).toBe("--no-docs-sites");
    expect(rows[2].reason).toBe("self_ingest: false");
  });

  it("failed.json: ids and statuses in order, and the failed reason", () => {
    const rows = parseGolden("failed");
    expect(brief(rows)).toEqual([
      CODE_REPO,
      ["docs_site:*", "skipped"],
      ["secondary_repo:test-org/sec-missing", "failed"],
      ["self:*", "skipped"],
    ]);
    expect(rows[2]).toMatchObject({ kind: "secondary_repo", reason: "checkout not found: /nonexistent-missing-dir-kgb45", counts: {} });
  });

  it("ingest-crash.json: the ingest:* entry is the last row and carries the crash reason", () => {
    const rows = parseGolden("ingest-crash");
    expect(brief(rows)).toEqual([
      CODE_REPO,
      ["docs_site:*", "skipped"],
      ["self:*", "skipped"],
      ["ingest:*", "failed"],
    ]);
    expect(rows[3]).toMatchObject({ kind: "ingest", reason: "deliberate post-loop failure for contract test" });
  });

  it.each(["success", "skipped", "failed", "ingest-crash"])("%s.json: a null reason (KGB's success) becomes an empty string", (name) => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/kgb-source-results/${name}.json`, import.meta.url)), "utf8")) as { reason: unknown }[];
    expect(raw[0].reason).toBeNull();
    expect(parseGolden(name)[0].reason).toBe("");
  });

  it("code_repo counts: number values are kept, string and boolean values are dropped", () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/kgb-source-results/success.json", import.meta.url)), "utf8")) as { counts: Record<string, unknown> }[];
    // The golden file really carries the non-number counts that the parser loses.
    expect(raw[0].counts).toMatchObject({
      history_branch: "main",
      is_default_branch: false,
      first_commit_date: expect.any(String),
      last_commit_date: expect.any(String),
    });
    expect(parseGolden("success")[0].counts).toEqual({
      files: 2,
      commits: 1,
      people: 1,
      prs: 0,
      pr_comments: 0,
      commit_cap: 5,
      pr_cap: 0,
    });
  });
});
