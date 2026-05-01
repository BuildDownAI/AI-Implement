import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCustomizations } from "../customizations.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "customizations-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("listCustomizations", () => {
  it("returns empty when custom/ doesn't exist", () => {
    const result = listCustomizations({ cwd: tempDir });
    expect(result.customizations).toEqual([]);
    expect(result.customRoot).toBe(path.join(tempDir, "custom"));
  });

  it("pipeline override + upstream exists → isShadow: true", () => {
    fs.mkdirSync(path.join(tempDir, "pipelines"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "pipelines", "autonomous.yml"), "steps: []");
    fs.mkdirSync(path.join(tempDir, "custom", "pipelines"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "custom", "pipelines", "autonomous.yml"), "steps: []");

    const result = listCustomizations({ cwd: tempDir });
    expect(result.customizations).toHaveLength(1);
    const entry = result.customizations[0];
    expect(entry.category).toBe("pipeline");
    expect(entry.isShadow).toBe(true);
    expect(entry.upstreamPath).toBe("pipelines/autonomous.yml");
  });

  it("step override without upstream → isShadow: false", () => {
    fs.mkdirSync(path.join(tempDir, "custom", "steps"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "custom", "steps", "hello.ts"), "export default {};");

    const result = listCustomizations({ cwd: tempDir });
    expect(result.customizations).toHaveLength(1);
    const entry = result.customizations[0];
    expect(entry.category).toBe("step");
    expect(entry.isShadow).toBe(false);
    expect(entry.upstreamPath).toBe("src/pipeline/steps/hello.ts");
  });

  it("README.md and .gitkeep are skipped", () => {
    fs.mkdirSync(path.join(tempDir, "custom", "pipelines"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "custom", "README.md"), "# readme");
    fs.writeFileSync(path.join(tempDir, "custom", "pipelines", ".gitkeep"), "");
    fs.writeFileSync(path.join(tempDir, "custom", "pipelines", "foo.yml"), "steps: []");

    const result = listCustomizations({ cwd: tempDir });
    expect(result.customizations).toHaveLength(1);
    expect(result.customizations[0].relativePath).toBe("pipelines/foo.yml");
  });

  it("other category for unrecognized path", () => {
    fs.mkdirSync(path.join(tempDir, "custom"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "custom", "notes.md"), "some notes");

    const result = listCustomizations({ cwd: tempDir });
    expect(result.customizations).toHaveLength(1);
    const entry = result.customizations[0];
    expect(entry.category).toBe("other");
    expect(entry.upstreamPath).toBeNull();
    expect(entry.isShadow).toBe(false);
  });
});
