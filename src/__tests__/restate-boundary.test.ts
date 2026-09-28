// The parent's closing work (AII-687): proves this tree's guarantees as tests rather than
// leaving them as claims in the issue body. Unit tests only — no Restate scenario, no
// Docker requirement (npm test must stay green with Docker unavailable).
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// ---- AII-717: widens the directory-list check above into a named allowlist over every
// src/**/*.ts file (outside src/__tests__/), so a new adapter module can't quietly start
// importing Restate without this test being touched. src/admin.ts is on the allowlist only
// for a *type* import (its `callTool` reference is used purely for a parameter type, never
// invoked), so it carries no runtime dependency on Restate — that's checked separately below.
describe("import allowlist: only the door adapters may import Restate from outside src/restate/ (AII-717)", () => {
  // deploy.ts is the self-deployment door: it probes the old Restate endpoint
  // before replacing the process (AII-810), without importing the SDK itself.
  const ALLOWLIST = new Set(["src/mcp.ts", "src/mcp-oauth.ts", "src/admin.ts", "src/index.ts", "src/deploy.ts"]);

  function listTsFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(listTsFiles(full));
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  /** Every static `import ... from "..."` and bare `import "..."` statement's module specifier and type-only-ness. */
  function extractImportSpecifiers(content: string): Array<{ isTypeOnly: boolean; source: string }> {
    const results: Array<{ isTypeOnly: boolean; source: string }> = [];
    const fromImport = /import\s+(type\s+)?[\w*\s{},]+\s+from\s+["']([^"']+)["']/g;
    const bareImport = /import\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = fromImport.exec(content)) !== null) {
      results.push({ isTypeOnly: Boolean(match[1]), source: match[2] });
    }
    while ((match = bareImport.exec(content)) !== null) {
      results.push({ isTypeOnly: false, source: match[1] });
    }
    return results;
  }

  const isRestateSpecifier = (source: string): boolean => source.startsWith("@restatedev/") || /(^|\/)restate\//.test(source);

  // src/**/*.ts outside src/__tests__/, with paths relative to the repo root and forward-slashed
  // (readdirSync/join already produce "/" on this project's CI and dev platforms).
  const allTsFiles = listTsFiles("src").filter((f) => !f.startsWith("src/__tests__/"));

  it("no file outside src/restate/ and the allowlist imports @restatedev/* or ./restate/*", () => {
    const violations: string[] = [];
    for (const file of allTsFiles) {
      if (file.startsWith("src/restate/")) continue;
      const content = readFileSync(file, "utf8");
      const restateImports = extractImportSpecifiers(content).filter((i) => isRestateSpecifier(i.source));
      if (restateImports.length === 0) continue;
      if (!ALLOWLIST.has(file)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("src/admin.ts's Restate import(s) are type-only — it carries no runtime Restate dependency", () => {
    const content = readFileSync("src/admin.ts", "utf8");
    const restateImports = extractImportSpecifiers(content).filter((i) => isRestateSpecifier(i.source));
    expect(restateImports.length).toBeGreaterThan(0);
    for (const imp of restateImports) {
      expect(imp.isTypeOnly, `src/admin.ts imports "${imp.source}" without "import type"`).toBe(true);
    }
  });

  it("src/deploy.ts imports only the endpoint drain adapters, never the SDK", () => {
    const imports = extractImportSpecifiers(readFileSync("src/deploy.ts", "utf8"))
      .filter((entry) => isRestateSpecifier(entry.source))
      .map((entry) => entry.source)
      .sort();
    expect(imports).toEqual(["./restate/drain.js", "./restate/endpoint.js", "./restate/server.js"]);
  });

  // Regression proof for the allowlist test itself (acceptance criterion): temporarily adding
  // `import "./restate/tools-client.js";` to src/stuck-watchdog.ts and rerunning `npm test`
  // makes the first test above fail with that file listed in `violations`, confirmed by hand
  // and reverted before this PR — see the PR description for the before/after transcript.
  it("sanity: the allowlist contains only the documented door and deployment adapters", () => {
    expect([...ALLOWLIST].sort()).toEqual(["src/admin.ts", "src/deploy.ts", "src/index.ts", "src/mcp-oauth.ts", "src/mcp.ts"]);
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

/**
 * The full `export const <identifier> = ...` source text for one handler, from its `export
 * const` line up to (but not including) the next top-level `export const` — every definition
 * in this file is one contiguous `export const` statement, so this is a safe slice despite the
 * nested braces/parens inside a `tool({...}, async (...) => {...})` call.
 */
function definitionBlockFor(identifier: string, source: string): string {
  const startMarker = `export const ${identifier} = `;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`could not locate "${startMarker}" in src/restate/tools.ts`);
  const nextExport = source.indexOf("\nexport const ", start + startMarker.length);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

// ---- AII-717: a static proxy for "this write's side effect is journaled and can't be
// re-delivered" — reading the actual retryPolicy/ctx.run wiring back out of a compiled Restate
// handler isn't practical from a unit test, so this checks the source text directly. It fails
// if either `ctx.run(` or `retryPolicy` is removed from any one `role: "admin"` handler's
// definition (the acceptance-criterion regression this test exists to catch).
describe("every role: \"admin\" handler wraps its side effect in ctx.run under a retryPolicy (AII-717)", () => {
  const handlerEntries = extractHandlerEntries(TOOLS_SOURCE);
  const writeEntries = handlerEntries.filter(({ identifier }) => /role:\s*"admin"/.test(definitionBlockFor(identifier, TOOLS_SOURCE)));

  it("found the six documented write handlers as role: \"admin\" (not zero, not accidentally all of them)", () => {
    expect(writeEntries.map((e) => e.toolName).sort()).toEqual(
      ["add_project", "clear_dispatch_dedup", "pause_project", "set_runner_mode", "trigger_kg_refresh", "trigger_workflow_sync"],
    );
  });

  it.each(writeEntries.map(({ toolName, identifier }) => [toolName, identifier] as const))(
    "%s (%s) contains both ctx.run( and retryPolicy in its definition",
    (_toolName, identifier) => {
      const block = definitionBlockFor(identifier, TOOLS_SOURCE);
      expect(block).toContain("ctx.run(");
      expect(block).toMatch(/retryPolicy\s*:/);
    },
  );

  it("no role: \"user\" handler declares a retryPolicy", () => {
    const readEntries = handlerEntries.filter((e) => !writeEntries.some((w) => w.identifier === e.identifier));
    for (const { identifier } of readEntries) {
      const block = definitionBlockFor(identifier, TOOLS_SOURCE);
      expect(block, `${identifier} is a read handler but declares retryPolicy`).not.toMatch(/retryPolicy\s*:/);
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
