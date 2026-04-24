import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Two levels up from src/ reaches the project root where custom/ lives.
const PROJECT_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ImportFn = (path: string) => Promise<unknown>;

function isModuleNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const message = (err as Error)?.message ?? "";
  return message.includes("Cannot find module");
}

export async function resolveModule<T>(
  path: string,
  importImpl: ImportFn = (p) => import(p),
): Promise<T> {
  const customPath = pathToFileURL(join(PROJECT_ROOT, "custom", path)).href;
  const builtinPath = pathToFileURL(join(PROJECT_ROOT, path)).href;
  for (const candidate of [customPath, builtinPath]) {
    try {
      return await importImpl(candidate) as T;
    } catch (err) {
      if (!isModuleNotFound(err)) throw err;
    }
  }
  throw new Error(`Module not found: tried ${customPath} and ${builtinPath}`);
}
