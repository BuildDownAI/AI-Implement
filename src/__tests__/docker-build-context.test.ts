import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCKERFILES = ["Dockerfile", "Dockerfile.session"];

const ignoreLines = readFileSync(".dockerignore", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

/** The top-level entry of each path a Dockerfile copies from the build context, never from an earlier stage. */
function contextSources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of readFileSync(dockerfile, "utf8").split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "COPY" && words[0] !== "ADD") continue;
    const args = words.slice(1);
    if (args.some((arg) => arg.startsWith("--from="))) continue;
    // Every argument but the last is a source; flags such as --chown come first.
    for (const source of args.filter((arg) => !arg.startsWith("--")).slice(0, -1)) {
      sources.push(source.replace(/^\.\//, "").split("/")[0]!);
    }
  }
  return [...new Set(sources)];
}

describe(".dockerignore", () => {
  it("excludes everything by default", () => {
    expect(ignoreLines[0]).toBe("*");
  });

  it.each(DOCKERFILES)("lets in every path %s copies", (dockerfile) => {
    const sources = contextSources(dockerfile);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const allowed = ignoreLines.includes(`!${source}`) || ignoreLines.includes(`!${source}/`);
      expect(allowed, `${dockerfile} copies ${source}, which .dockerignore keeps out of the build context`).toBe(true);
    }
  });

  it("keeps secrets and the local database out even inside an allowed directory", () => {
    for (const pattern of ["**/.env", "**/.env.*", "**/*.pem", "**/*.sqlite", "**/*.sqlite-*"]) {
      expect(ignoreLines).toContain(pattern);
    }
  });
});
