import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const SIZE_OF = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** `from "./name.js"` in an import or re-export, including multi-line specifier lists. */
const SAME_FOLDER_IMPORT = /\bfrom\s+["']\.\/([^/"']+)\.js["']/g;

/** A test file's byte size plus the bytes of each same-folder module it imports (one level). */
export function weightOf(filePath: string): number {
  let weight = SIZE_OF(filePath);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return weight;
  }
  const seen = new Set<string>();
  for (const match of source.matchAll(SAME_FOLDER_IMPORT)) {
    seen.add(match[1]);
  }
  for (const name of seen) {
    weight += SIZE_OF(join(dirname(filePath), `${name}.ts`));
  }
  return weight;
}

/**
 * Vitest with no results cache starts the largest files first by byte size, so thin files that
 * delegate to a big shared module start last (AII-1166). Weigh a file by what it imports instead.
 */
export class RestateSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const weights = new Map(sorted.map((file) => [file, weightOf(file.moduleId)] as const));
    return [...sorted].sort((a, b) => weights.get(b)! - weights.get(a)!);
  }
}
