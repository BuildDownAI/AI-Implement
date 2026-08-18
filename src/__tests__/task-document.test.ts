import { describe, it, expect } from "vitest";
import { parseTaskDocument } from "../task-document.js";

const MINIMAL = `---\ntitle: My Feature\n---\n\nDo the thing.`;

describe("parseTaskDocument", () => {
  // ── Minimal valid document ──────────────────────────────────────────────
  it("parses title and body from a minimal document", () => {
    const result = parseTaskDocument(MINIMAL);
    expect(result.issue.title).toBe("My Feature");
    expect(result.issue.description).toBe("Do the thing.");
    expect(result.v).toBe(1);
  });

  it("generates a UUID for issue.id", () => {
    const result = parseTaskDocument(MINIMAL);
    expect(result.issue.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("uses the provided issueId parameter for issue.id", () => {
    const result = parseTaskDocument(MINIMAL, "fixed-uuid-1234");
    expect(result.issue.id).toBe("fixed-uuid-1234");
  });

  it("uses a DEV-timestamp fallback for issue.identifier when id is absent", () => {
    const result = parseTaskDocument(MINIMAL);
    expect(result.issue.identifier).toMatch(/^DEV-\d+$/);
  });

  // ── Optional fields → RunConfigV1 mappings ──────────────────────────────
  it("maps 'id' to issue.identifier", () => {
    const content = `---\ntitle: T\nid: DEV-42\n---\n\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.issue.identifier).toBe("DEV-42");
  });

  it("maps 'base' to baseBranch", () => {
    const content = `---\ntitle: T\nbase: feature/abc\n---\n\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.baseBranch).toBe("feature/abc");
  });

  it("leaves baseBranch absent when 'base' is not set", () => {
    const result = parseTaskDocument(MINIMAL);
    expect(result.baseBranch).toBeUndefined();
  });

  it("maps 'profiles' to profiles", () => {
    const content = `---\ntitle: T\nprofiles:\n  - backend\n  - webapp\n---\n\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.profiles).toEqual(["backend", "webapp"]);
  });

  it("maps 'limits.maxTurns' to maxTurns", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 50\n---\n\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.maxTurns).toBe(50);
  });

  it("maps 'limits.maxIterations' to maxIterations", () => {
    const content = `---\ntitle: T\nlimits:\n  maxIterations: 3\n---\n\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.maxIterations).toBe(3);
  });

  it("maps all optional fields together", () => {
    const content = [
      "---",
      "title: Full Task",
      "id: PROJ-7",
      "base: main",
      "profiles:",
      "  - backend",
      "limits:",
      "  maxTurns: 20",
      "  maxIterations: 2",
      "---",
      "",
      "Do the work.",
    ].join("\n");
    const result = parseTaskDocument(content);
    expect(result.issue.identifier).toBe("PROJ-7");
    expect(result.issue.title).toBe("Full Task");
    expect(result.issue.description).toBe("Do the work.");
    expect(result.baseBranch).toBe("main");
    expect(result.profiles).toEqual(["backend"]);
    expect(result.maxTurns).toBe(20);
    expect(result.maxIterations).toBe(2);
  });

  // ── Body → description ──────────────────────────────────────────────────
  it("trims leading/trailing whitespace from title and description", () => {
    const content = `---\ntitle:   Padded Title   \n---\n\n   Body text.   `;
    const result = parseTaskDocument(content);
    expect(result.issue.title).toBe("Padded Title");
    expect(result.issue.description).toBe("Body text.");
  });

  it("produces empty string description when body is absent", () => {
    const content = `---\ntitle: No Body\n---\n`;
    const result = parseTaskDocument(content);
    expect(result.issue.description).toBe("");
  });

  it("preserves multi-line body including acceptance criteria", () => {
    const content =
      `---\ntitle: T\n---\n\nLine one.\n\n## Acceptance Criteria\n\n- [ ] Item A\n- [ ] Item B`;
    const result = parseTaskDocument(content);
    expect(result.issue.description).toContain("## Acceptance Criteria");
    expect(result.issue.description).toContain("- [ ] Item A");
  });

  it("accepts CRLF line endings", () => {
    const content = `---\r\ntitle: CRLF Task\r\n---\r\n\r\nBody.`;
    const result = parseTaskDocument(content);
    expect(result.issue.title).toBe("CRLF Task");
  });

  // ── Structural errors ───────────────────────────────────────────────────
  it("throws when front matter block is absent", () => {
    expect(() => parseTaskDocument("no front matter here")).toThrow(/front matter/i);
  });

  it("throws on invalid YAML in front matter", () => {
    expect(() => parseTaskDocument(`---\ntitle: [\n---\n\nBody.`)).toThrow(/YAML/i);
  });

  it("throws when title is missing", () => {
    expect(() => parseTaskDocument(`---\nid: DEV-1\n---\n\nBody.`)).toThrow(/'title'/);
  });

  it("throws when title is blank", () => {
    expect(() => parseTaskDocument(`---\ntitle:   \n---\n\nBody.`)).toThrow(/'title'/);
  });

  // ── Unknown-field rejection ─────────────────────────────────────────────
  it("rejects an unknown field and names it in the error", () => {
    const content = `---\ntitle: T\nfooBar: 123\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/fooBar/);
  });

  it("includes an example in the unknown-field error", () => {
    const content = `---\ntitle: T\nfooBar: 123\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/title/);
  });

  // ── Rejected-field categories ───────────────────────────────────────────
  it("rejects 'repo' with a repository-path message", () => {
    const content = `---\ntitle: T\nrepo: acme/app\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("'repo'");
    expect(() => parseTaskDocument(content)).toThrow("repository path");
  });

  it("rejects 'identifier' and suggests 'id'", () => {
    const content = `---\ntitle: T\nidentifier: PROJ-7\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("'identifier'");
    expect(() => parseTaskDocument(content)).toThrow("'id'");
  });

  it("rejects 'branch' and suggests 'base'", () => {
    const content = `---\ntitle: T\nbranch: feature-x\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("'branch'");
    expect(() => parseTaskDocument(content)).toThrow("'base'");
  });

  it("rejects top-level 'maxTurns' and suggests the limits block", () => {
    const content = `---\ntitle: T\nmaxTurns: 50\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("'maxTurns'");
    expect(() => parseTaskDocument(content)).toThrow("limits");
  });

  it("rejects top-level 'maxIterations' and suggests the limits block", () => {
    const content = `---\ntitle: T\nmaxIterations: 3\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("'maxIterations'");
    expect(() => parseTaskDocument(content)).toThrow("limits");
  });

  it("rejects credential fields", () => {
    for (const field of ["anthropicApiKey", "githubToken", "token", "secret"]) {
      const content = `---\ntitle: T\n${field}: supersecret\n---\n\nBody.`;
      expect(() => parseTaskDocument(content)).toThrow(/credential/i);
    }
  });

  // ── Optional-field validation ───────────────────────────────────────────
  it("rejects non-string 'id'", () => {
    const content = `---\ntitle: T\nid: 42\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'id'/);
  });

  it("rejects empty 'id'", () => {
    const content = `---\ntitle: T\nid: ""\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'id'/);
  });

  it("rejects non-string 'base'", () => {
    const content = `---\ntitle: T\nbase: 123\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'base'/);
  });

  it("rejects empty 'base'", () => {
    const content = `---\ntitle: T\nbase: ""\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'base'/);
  });

  it("rejects empty profiles list", () => {
    const content = `---\ntitle: T\nprofiles: []\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'profiles'/);
  });

  it("rejects non-array profiles", () => {
    const content = `---\ntitle: T\nprofiles: backend\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'profiles'/);
  });

  it("rejects profiles with a non-string entry", () => {
    const content = `---\ntitle: T\nprofiles:\n  - backend\n  - 42\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'profiles'/);
  });

  it("rejects profiles with duplicate values", () => {
    const content = `---\ntitle: T\nprofiles:\n  - backend\n  - backend\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("duplicate");
    expect(() => parseTaskDocument(content)).toThrow("backend");
  });

  it("rejects non-object limits", () => {
    const content = `---\ntitle: T\nlimits: 50\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/'limits'/);
  });

  it("rejects unknown key inside limits", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 10\n  bogus: 1\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow("limits.bogus");
  });

  it("rejects limits.maxTurns that is zero", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 0\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/limits\.maxTurns/);
  });

  it("rejects limits.maxTurns that is negative", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: -5\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/limits\.maxTurns/);
  });

  it("rejects non-integer limits.maxTurns", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 3.5\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/limits\.maxTurns/);
  });

  it("rejects limits.maxIterations that is zero", () => {
    const content = `---\ntitle: T\nlimits:\n  maxIterations: 0\n---\n\nBody.`;
    expect(() => parseTaskDocument(content)).toThrow(/limits\.maxIterations/);
  });
});
