// Pins GITHUB_APP_PERMISSIONS to every permission the code and the synced workflows request, and to the install guide's table.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GITHUB_APP_PERMISSIONS, permissionLevelCovers, type GitHubPermissionLevel } from "../github-app-permissions.js";

const declared = new Map<string, GitHubPermissionLevel>(GITHUB_APP_PERMISSIONS.map((p) => [p.name, p.level]));

function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : productionSources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Each `permissions: { … }` literal in production source outside the declaration itself, with the grants it names. */
function tokenRequests(): Array<{ site: string; grants: Array<{ name: string; level: string }> }> {
  return productionSources("src").filter((file) => file !== join("src", "github-app-permissions.ts")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/permissions:\s*\{([^}]*)\}/g)].map((literal) => ({
      site: `${file}:${text.slice(0, literal.index).split("\n").length}`,
      grants: [...literal[1].matchAll(/(\w+):\s*"(\w+)"/g)].map(([, name, level]) => ({ name, level })),
    }));
  });
}

/** The `permission-<name>: <level>` inputs a synced workflow passes to `create-github-app-token`. */
function workflowRequests(file: string): Array<{ name: string; level: string }> {
  return [...readFileSync(file, "utf8").matchAll(/^\s*permission-([a-z-]+):\s*(\S+)\s*$/gm)].map(([, name, level]) => ({
    name: name.replace(/-/g, "_"),
    level,
  }));
}

function expectDeclared(grant: { name: string; level: string }, site: string): void {
  expect(declared.has(grant.name), `${site} requests ${grant.name}, which GITHUB_APP_PERMISSIONS does not declare`).toBe(true);
  expect(["read", "write"], `${site} requests ${grant.name}: ${grant.level}`).toContain(grant.level);
  expect(
    permissionLevelCovers(declared.get(grant.name), grant.level as GitHubPermissionLevel),
    `${site} requests ${grant.name}: ${grant.level}, above the declared ${declared.get(grant.name)}`,
  ).toBe(true);
}

describe("permissionLevelCovers", () => {
  it.each([
    ["write", "write", true],
    ["write", "read", true],
    ["read", "read", true],
    ["read", "write", false],
    [undefined, "read", false],
    ["admin", "read", false],
  ] as const)("held %s covers needed %s: %s", (held, needed, covers) => {
    expect(permissionLevelCovers(held, needed)).toBe(covers);
  });
});

describe("GITHUB_APP_PERMISSIONS", () => {
  it("reads a grant from every token request it finds", () => {
    const requests = tokenRequests();
    expect(requests.map((r) => r.site)).toContainEqual(expect.stringContaining("publication-token-vending.ts"));
    for (const request of requests) expect(request.grants, `${request.site} names no grant this test can read`).not.toHaveLength(0);
  });

  it("declares every permission a token request in src/ names, at or above its level", () => {
    for (const request of tokenRequests()) for (const grant of request.grants) expectDeclared(grant, request.site);
  });

  it.each(["workflows/claude-implement.yml", "workflows/claude-plan.yml"])("declares every permission %s requests", (file) => {
    for (const grant of workflowRequests(file)) expectDeclared(grant, file);
  });

  it("reads the permission inputs of the implement workflow", () => {
    expect(workflowRequests("workflows/claude-implement.yml")).toContainEqual({ name: "metadata", level: "read" });
  });

  it("matches the table in docs/deployment.md § GitHub App permissions", () => {
    const doc = readFileSync("docs/deployment.md", "utf8");
    const section = doc.slice(doc.indexOf("## GitHub App permissions"), doc.indexOf("\n## ", doc.indexOf("## GitHub App permissions") + 1));
    const LEVELS: Record<string, string> = { "Read and write": "write", "Read-only": "read" };
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.startsWith("| Repository permission") && !line.startsWith("|---"))
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .map(([, title, level]) => ({ title, level: LEVELS[level] ?? level }));
    const expected = GITHUB_APP_PERMISSIONS.map(({ title, level }) => ({ title, level }));
    const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);
    expect(rows.sort(byTitle)).toEqual([...expected].sort(byTitle));
  });
});
