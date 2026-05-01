import fs from "node:fs";
import path from "node:path";

export interface CustomizationEntry {
  relativePath: string;
  customPath: string;
  category: "pipeline" | "step" | "provider" | "other";
  upstreamPath: string | null;
  isShadow: boolean;
  customSize: number;
  customMtime: number;
}

const SKIPPED_FILES = new Set(["README.md", ".gitkeep"]);

function categorize(relativePath: string): { category: CustomizationEntry["category"]; upstream: string | null } {
  if (relativePath.startsWith("pipelines/")) {
    return { category: "pipeline", upstream: relativePath };
  }
  if (relativePath.startsWith("steps/")) {
    const base = relativePath.replace(/^steps\//, "").replace(/\.(ts|js|mjs)$/, "");
    return { category: "step", upstream: `src/pipeline/steps/${base}.ts` };
  }
  if (relativePath.startsWith("providers/")) {
    const base = relativePath.replace(/^providers\//, "").replace(/\.(ts|js|mjs)$/, "");
    return { category: "provider", upstream: `src/pipeline/providers/${base}.ts` };
  }
  return { category: "other", upstream: null };
}

function walk(root: string, prefix: string, out: string[]): void {
  const dir = prefix ? path.join(root, prefix) : root;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    if (SKIPPED_FILES.has(ent.name)) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

export function listCustomizations(opts?: { customRoot?: string; cwd?: string }): {
  customRoot: string;
  customizations: CustomizationEntry[];
} {
  const cwd = opts?.cwd ?? process.cwd();
  const customRoot = opts?.customRoot ?? path.join(cwd, "custom");

  if (!fs.existsSync(customRoot)) {
    return { customRoot, customizations: [] };
  }

  const files: string[] = [];
  walk(customRoot, "", files);

  const entries: CustomizationEntry[] = files.map((relativePath) => {
    const customPath = path.posix.join("custom", relativePath);
    const absCustom = path.join(customRoot, relativePath);
    const stat = fs.statSync(absCustom);
    const { category, upstream } = categorize(relativePath);
    let upstreamPath: string | null = null;
    let isShadow = false;
    if (upstream) {
      upstreamPath = upstream;
      isShadow = fs.existsSync(path.join(cwd, upstream));
    }
    return {
      relativePath,
      customPath,
      category,
      upstreamPath,
      isShadow,
      customSize: stat.size,
      customMtime: stat.mtimeMs,
    };
  });

  entries.sort((a, b) =>
    a.category.localeCompare(b.category) ||
    a.relativePath.localeCompare(b.relativePath),
  );

  return { customRoot, customizations: entries };
}
