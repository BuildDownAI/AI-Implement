// The parent's closing work (AII-687): proves this tree's guarantees as tests rather than
// leaving them as claims in the issue body. Unit tests only — no Restate scenario, no
// Docker requirement (npm test must stay green with Docker unavailable).
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function gitGrepFiles(pattern: string, paths: string[]): string[] {
  try {
    const output = execSync(`git grep -l '${pattern}' -- ${paths.join(" ")}`, { encoding: "utf8" });
    return output.trim().split("\n").filter(Boolean);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return []; // git grep: no matches
    throw err;
  }
}

describe("dependency direction: the main pipeline never reaches into Restate (AII-687)", () => {
  it("no file under src/pipeline/, workflows/, or src/github.ts imports @restatedev/* or src/restate/", () => {
    // Matches "restate/" rather than "src/restate/" literally: a relative import from
    // src/pipeline/ (e.g. "../restate/tools.js") never spells the "src/" prefix, so the
    // literal string from the issue's operator-run command would miss a real violation.
    const hits = gitGrepFiles("@restatedev\\|restate/", ["src/pipeline/", "workflows/", "src/github.ts"]);
    expect(hits).toEqual([]);
  });
});

describe("src/mcp.ts is adapter-only: the pre-migration tool registries are gone (AII-687)", () => {
  it("contains no DIAG_TOOLS, WRITE_TOOLS, or proxyCall", () => {
    const content = readFileSync("src/mcp.ts", "utf8");
    expect(content).not.toMatch(/\bDIAG_TOOLS\b/);
    expect(content).not.toMatch(/\bWRITE_TOOLS\b/);
    expect(content).not.toMatch(/\bproxyCall\b/);
  });
});

const TOOLS_SOURCE = readFileSync("src/restate/tools.ts", "utf8");
const MCP_DOC = readFileSync("docs/mcp-server.md", "utf8");

/** One `toolName: identifier` pair per line of orchestratorTools' `handlers: { ... }` object. */
function extractHandlerEntries(source: string): Array<{ toolName: string; identifier: string }> {
  const serviceMatch = source.match(/export const orchestratorTools = restate\.service\(\{[\s\S]*?handlers:\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);/);
  if (!serviceMatch) throw new Error("could not locate orchestratorTools' handlers block in src/restate/tools.ts");
  return [...serviceMatch[1].matchAll(/(\w+):\s*(\w+),/g)].map(([, toolName, identifier]) => ({ toolName, identifier }));
}

/** Every backtick-quoted name in a `docs/mcp-server.md` tools table row (`| \`name\` | user|admin |`), plus the kg_* names named in the KG-reads prose paragraph. */
function extractDocumentedToolNames(doc: string): Set<string> {
  const start = doc.indexOf("\n## Tools\n");
  const end = doc.indexOf("\n## Run identities\n");
  if (start === -1 || end === -1) throw new Error("could not locate the ## Tools section in docs/mcp-server.md");
  const section = doc.slice(start, end);
  const tableNames = [...section.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|\s*(?:user|admin)\s*\|/gm)].map((m) => m[1]);
  const kgNames = [...section.matchAll(/`(kg_[a-z0-9_]+)`/g)].map((m) => m[1]);
  return new Set([...tableNames, ...kgNames]);
}

describe("orchestratorTools' handlers carry mcp.type/mcp.role metadata and match docs/mcp-server.md (AII-687)", () => {
  const handlerEntries = extractHandlerEntries(TOOLS_SOURCE);

  it("found at least one handler to check (the parser matched the source)", () => {
    expect(handlerEntries.length).toBeGreaterThan(0);
  });

  it("every handler is declared via the tool()/kgTool() wrapper, which always sets mcp.type/mcp.role metadata", () => {
    for (const { identifier } of handlerEntries) {
      const declaredViaWrapper = new RegExp(`export const ${identifier} = (?:tool|kgTool)\\(`).test(TOOLS_SOURCE);
      expect(declaredViaWrapper, `${identifier} is not declared via tool()/kgTool() in src/restate/tools.ts`).toBe(true);
    }
  });

  it("every handler has a row in docs/mcp-server.md's tools tables", () => {
    const documented = extractDocumentedToolNames(MCP_DOC);
    for (const { toolName } of handlerEntries) {
      expect(documented.has(toolName), `${toolName} is a handler but has no row in docs/mcp-server.md`).toBe(true);
    }
  });

  it("every documented tool name is either an exported handler or get_session_identity", () => {
    const documented = extractDocumentedToolNames(MCP_DOC);
    const handlerNames = new Set(handlerEntries.map((e) => e.toolName));
    for (const name of documented) {
      if (name === "get_session_identity") continue;
      expect(handlerNames.has(name), `docs/mcp-server.md documents "${name}", which is not a handler in orchestratorTools`).toBe(true);
    }
  });
});

describe("ADR 025 exists, is Proposed, and is linked from CLAUDE.md's subsystem index (AII-687)", () => {
  it("docs/adr/025-*.md exists with Status: Proposed and is referenced from CLAUDE.md", () => {
    const adrFiles = readdirSync("docs/adr").filter((f) => /^025-.*\.md$/.test(f));
    expect(adrFiles).toHaveLength(1);
    const adrContent = readFileSync(`docs/adr/${adrFiles[0]}`, "utf8");
    expect(adrContent).toContain("**Status:** Proposed");
    const claudeMd = readFileSync("CLAUDE.md", "utf8");
    expect(claudeMd).toContain(`docs/adr/${adrFiles[0]}`);
  });
});
