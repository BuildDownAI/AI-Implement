import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("orchestrator runtime version", () => {
  it("pins every Docker stage to the repository Node version and one immutable image", () => {
    const nodeVersion = readFileSync(".node-version", "utf8").trim();
    const nvmVersion = readFileSync(".nvmrc", "utf8").trim();
    const toolVersionsNode = readFileSync(".tool-versions", "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("nodejs "))
      ?.split(/\s+/)[1];

    expect(nvmVersion).toBe(nodeVersion);
    expect(toolVersionsNode).toBe(nodeVersion);

    const dockerfile = readFileSync("Dockerfile", "utf8");
    const nodeImages = [...dockerfile.matchAll(/^FROM\s+(node:\S+)/gm)].map((match) => match[1]);

    expect(nodeImages).toHaveLength(2);
    expect(new Set(nodeImages).size).toBe(1);
    expect(nodeImages[0]).toMatch(
      new RegExp(`^node:${nodeVersion.replaceAll(".", "\\.")}-alpine@sha256:[a-f0-9]{64}$`),
    );
  });
});
