import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, it, expect, vi } from "vitest";
import { validateTicketingConfig, resolveRepoFieldValue, DEFAULT_TICKETING_CONFIG, TicketingConfigError } from "../../providers/ticketing-config.js";
import { resolveCustomFieldIds } from "../../providers/jira-fields.js";
import type { JiraMappingConfig } from "../../providers/ticketing-config.js";

const jiraBase = { kind: "jira", jql: "project = ENG", repoFieldValue: "owner/repo" };

/** The refusal validateTicketingConfig throws for these arguments. */
function refusal(...args: Parameters<typeof validateTicketingConfig>): TicketingConfigError {
  try {
    validateTicketingConfig(...args);
  } catch (err) {
    if (err instanceof TicketingConfigError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("validateTicketingConfig", () => {
  it("accepts and normalizes an absolute filesystem directory", () => {
    expect(validateTicketingConfig("filesystem", { kind: "filesystem", directory: " /tmp/test-tickets/ " }))
      .toEqual({ kind: "filesystem", directory: "/tmp/test-tickets/" });
  });

  it.each([undefined, "", "tickets", "~/tickets", "/tmp/\0tickets"])("rejects invalid filesystem directory %s", (directory) => {
    const err = refusal("filesystem", { kind: "filesystem", directory });
    expect(err.key).toBe("directory");
    expect(err.message).toContain("ticketingConfig.directory");
  });

  it("returns the linear default for a null config on the linear provider", () => {
    expect(validateTicketingConfig("linear", null)).toEqual(DEFAULT_TICKETING_CONFIG);
  });

  it("throws when kind does not match the provider", () => {
    expect(() => validateTicketingConfig("jira", { kind: "linear" })).toThrow(/must match ticketingProvider/);
  });

  it("requires a non-empty jql for jira, naming it by its path in the stored data", () => {
    const noJql = refusal("jira", { kind: "jira", repoFieldValue: "owner/repo" });
    const blankJql = refusal("jira", { kind: "jira", jql: "  ", repoFieldValue: "owner/repo" });
    expect([noJql.key, blankJql.key]).toEqual(["jql", "jql"]);
    expect(noJql.message).toContain("ticketingConfig.jql");
  });

  // The save names each setting by its label, while the stored data's own callers keep its paths.
  it("names a key by the subject its caller gives", () => {
    const subject = (key: string) => `the ${key} setting`;
    expect(refusal("jira", { kind: "jira", repoFieldValue: "owner/repo" }, subject).message).toContain("the jql setting");
    expect(refusal("filesystem", { kind: "filesystem", directory: "relative" }, subject).message).toContain("the directory setting");
  });

  // A missing value is derived from the mapping's owner/repo by resolveRepoFieldValue.
  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
  ])("stores a repoFieldValue that is %s as null", (_label, repoFieldValue) => {
    const cfg = validateTicketingConfig("jira", { kind: "jira", jql: "project = ENG", repoFieldValue }) as JiraMappingConfig;
    expect(cfg.repoFieldValue).toBeNull();
  });

  it("keeps an explicit repoFieldValue, trimmed", () => {
    const cfg = validateTicketingConfig("jira", { ...jiraBase, repoFieldValue: "  Backend Service  " }) as JiraMappingConfig;
    expect(cfg.repoFieldValue).toBe("Backend Service");
  });

  it("keeps a valid field override, trimmed", () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "  customfield_10042  ",
    }) as JiraMappingConfig;
    expect(cfg.statusFieldOverride).toBe("customfield_10042");
  });

  // The bug this file exists for: a blank-but-present override used to survive
  // validation and reach jira-fields.ts as a literal field id.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
  ])("normalizes a %s field override to null", (_label, value) => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: value,
      repoFieldOverride: value,
      profilesFieldOverride: value,
    }) as JiraMappingConfig;
    expect(cfg.statusFieldOverride).toBeNull();
    expect(cfg.repoFieldOverride).toBeNull();
    expect(cfg.profilesFieldOverride).toBeNull();
  });
});

describe("resolveRepoFieldValue", () => {
  const jiraProject = (repoFieldValue: unknown) => ({
    owner: "acme",
    repo: "backend",
    ticketingConfig: validateTicketingConfig("jira", { kind: "jira", jql: "project = ENG", repoFieldValue }),
  });

  it("derives owner/repo when no value is stored", () => {
    expect(resolveRepoFieldValue(jiraProject(null))).toBe("acme/backend");
  });

  it("matches on an explicit value rather than owner/repo", () => {
    expect(resolveRepoFieldValue(jiraProject("Backend Service"))).toBe("Backend Service");
  });

  // A stored null means owner/repo, and comparing a string with null still compiles, so a read that
  // skips the resolver matches nothing for such a project. The admin UI's forms edit the stored value itself.
  // Parsed rather than searched, so a comment, a log line or a type that names the field does not count.
  const sitesIn = (file: string, text: string): string[] => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const sites: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "repoFieldValue") {
        sites.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return sites;
  };
  const repoFieldValueSites = (file: string): string[] => sitesIn(file, readFileSync(file, "utf8"));
  const filesNamingTheField = execFileSync("git", ["grep", "--untracked", "-l", "-w", "repoFieldValue", "--", "src/*.ts"], { encoding: "utf8" })
    .trim().split("\n").filter((file) => !file.includes("/__tests__/"));

  it("the scan counts a read of the field and skips a type that names it", () => {
    const text = 'type Key = `ticketingConfig.${"repoFieldValue"}`;\nconst value = (cfg as { repoFieldValue: string }).repoFieldValue;\n';
    expect(sitesIn("probe.ts", text)).toEqual(["probe.ts:2"]);
  });

  it("the scan sees the resolver's own reads", () => {
    expect(repoFieldValueSites("src/providers/ticketing-config.ts")).not.toHaveLength(0);
  });

  it("is the only production code outside the admin UI that reads the stored value", () => {
    const outside = filesNamingTheField.filter((file) => file !== "src/providers/ticketing-config.ts" && !file.startsWith("src/admin-ui/"));
    expect(outside.flatMap(repoFieldValueSites)).toEqual([]);
  });
});

describe("blank overrides no longer reach jira-fields as field ids", () => {
  const fields = [
    { id: "customfield_10042", name: "AI-Implement Status", custom: true },
    { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
  ];

  const overridesFrom = (cfg: JiraMappingConfig) => ({
    statusOverride: cfg.statusFieldOverride ?? null,
    repoOverride: cfg.repoFieldOverride ?? null,
    profilesOverride: cfg.profilesFieldOverride ?? null,
    baseBranchOverride: cfg.baseBranchFieldOverride ?? null,
  });

  it('falls back to discovery by name for an "" override rather than using it as an id', async () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "",
      repoFieldOverride: "",
    }) as JiraMappingConfig;
    const client = { listFields: vi.fn().mockResolvedValue(fields) };

    const ids = await resolveCustomFieldIds(client as any, overridesFrom(cfg));

    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });

  it("still calls listFields when every override is whitespace-only", async () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "   ",
      repoFieldOverride: "   ",
      profilesFieldOverride: "   ",
    }) as JiraMappingConfig;
    const client = { listFields: vi.fn().mockResolvedValue(fields) };

    const ids = await resolveCustomFieldIds(client as any, overridesFrom(cfg));

    // Before the fix these were truthy, so the all-overrides-set short-circuit
    // returned "   " for all three and listFields was never called.
    expect(client.listFields).toHaveBeenCalled();
    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });
});
