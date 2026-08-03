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
