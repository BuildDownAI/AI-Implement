import { describe, it, expect } from "vitest";
import { parseTaskFile } from "../dev-harness/task-file.js";

describe("parseTaskFile", () => {
  const MINIMAL = `---\ntitle: My Feature\n---\n\nDo the thing.`;

  it("parses title and body from minimal front matter", () => {
    const result = parseTaskFile(MINIMAL);
    expect(result.title).toBe("My Feature");
    expect(result.description).toBe("Do the thing.");
  });

  it("auto-generates identifier when not present", () => {
    const result = parseTaskFile(MINIMAL, "DEV-42");
    expect(result.identifier).toBe("DEV-42");
  });

  it("uses provided defaultIdentifier when front matter has no identifier", () => {
    const result = parseTaskFile(MINIMAL, "DEV-99");
    expect(result.identifier).toBe("DEV-99");
  });

  it("respects identifier from front matter over defaultIdentifier", () => {
    const content = `---\nidentifier: PROJ-7\ntitle: Some Work\n---\n\nDo stuff.`;
    const result = parseTaskFile(content, "DEV-99");
    expect(result.identifier).toBe("PROJ-7");
  });

  it("parses optional maxTurns and maxIterations as positive integers", () => {
    const content = `---\ntitle: Capped Run\nmaxTurns: 20\nmaxIterations: 2\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxTurns).toBe(20);
    expect(result.maxIterations).toBe(2);
  });

  it("ignores maxTurns / maxIterations that are zero or negative", () => {
    const content = `---\ntitle: Bad Caps\nmaxTurns: 0\nmaxIterations: -1\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxTurns).toBeUndefined();
    expect(result.maxIterations).toBeUndefined();
  });

  it("ignores non-integer maxTurns", () => {
    const content = `---\ntitle: T\nmaxTurns: 3.5\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxTurns).toBeUndefined();
  });

  it("parses optional repo and branch", () => {
    const content = `---\ntitle: PR Work\nrepo: acme/app\nbranch: feature-x\n---\n\nImpl.`;
    const result = parseTaskFile(content);
    expect(result.repo).toBe("acme/app");
    expect(result.branch).toBe("feature-x");
  });

  it("leaves repo and branch undefined when not specified", () => {
    const result = parseTaskFile(MINIMAL);
    expect(result.repo).toBeUndefined();
    expect(result.branch).toBeUndefined();
  });

  it("throws when front matter block is absent", () => {
    expect(() => parseTaskFile("no front matter here")).toThrow(/front matter/);
  });

  it("throws when title is missing", () => {
    const content = `---\nidentifier: DEV-1\n---\n\nBody.`;
    expect(() => parseTaskFile(content)).toThrow(/title/);
  });

  it("throws when title is blank", () => {
    const content = `---\ntitle:   \n---\n\nBody.`;
    expect(() => parseTaskFile(content)).toThrow(/title/);
  });

  it("throws on invalid YAML in front matter", () => {
    const content = `---\ntitle: [\n---\n\nBody.`;
    expect(() => parseTaskFile(content)).toThrow(/YAML/i);
  });

  it("trims leading/trailing whitespace from title and description", () => {
    const content = `---\ntitle:   Padded Title   \n---\n\n   Body text.   `;
    const result = parseTaskFile(content);
    expect(result.title).toBe("Padded Title");
    expect(result.description).toBe("Body text.");
  });

  it("accepts CRLF line endings in front matter delimiter", () => {
    const content = `---\r\ntitle: CRLF Task\r\n---\r\n\r\nBody.`;
    const result = parseTaskFile(content);
    expect(result.title).toBe("CRLF Task");
  });

  it("produces empty string description when body is absent", () => {
    const content = `---\ntitle: No Body\n---\n`;
    const result = parseTaskFile(content);
    expect(result.description).toBe("");
  });
});

describe("parseTaskFile — compatibility adapter (new field names)", () => {
  it("accepts the new 'id' field as the identifier", () => {
    const content = `---\ntitle: T\nid: PROJ-7\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.identifier).toBe("PROJ-7");
  });

  it("accepts the new 'base' field as the branch", () => {
    const content = `---\ntitle: T\nbase: feature/abc\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.branch).toBe("feature/abc");
  });

  it("accepts the new 'limits' block for maxTurns", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 30\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxTurns).toBe(30);
  });

  it("accepts the new 'limits' block for maxIterations", () => {
    const content = `---\ntitle: T\nlimits:\n  maxIterations: 4\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxIterations).toBe(4);
  });

  it("new 'id' field wins over legacy 'identifier' when both are present", () => {
    const content = `---\ntitle: T\nid: NEW-1\nidentifier: OLD-1\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.identifier).toBe("NEW-1");
  });

  it("new 'base' field wins over legacy 'branch' when both are present", () => {
    const content = `---\ntitle: T\nbase: new-branch\nbranch: old-branch\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.branch).toBe("new-branch");
  });

  it("new 'limits' block wins over legacy top-level maxTurns when both are present", () => {
    const content = `---\ntitle: T\nlimits:\n  maxTurns: 99\nmaxTurns: 5\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.maxTurns).toBe(99);
  });

  it("returns profiles from the task file", () => {
    const content = `---\ntitle: T\nprofiles:\n  - backend\n  - webapp\n---\n\nBody.`;
    const result = parseTaskFile(content);
    expect(result.profiles).toEqual(["backend", "webapp"]);
  });

  it("leaves profiles undefined when not specified", () => {
    const result = parseTaskFile(`---\ntitle: T\n---\n\nBody.`);
    expect(result.profiles).toBeUndefined();
  });

  it("rejects unknown fields not in the legacy or new schema", () => {
    const content = `---\ntitle: T\nfooBar: x\n---\n\nBody.`;
    expect(() => parseTaskFile(content)).toThrow(/fooBar/);
  });

  it("rejects credential fields even through the compatibility adapter", () => {
    const content = `---\ntitle: T\nanthropicApiKey: secret\n---\n\nBody.`;
    expect(() => parseTaskFile(content)).toThrow(/credential/i);
  });
});
