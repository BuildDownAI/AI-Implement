import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two levels up from src/pipeline/ reaches the project root where pipelines/ lives.
const BUILTIN_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface ResolveModuleOptions {
  /** Root directory to look for custom/ overrides. Defaults to process.cwd(). */
  customRoot?: string;
  /** Root directory for built-in files. Defaults to the package root. */
  builtinRoot?: string;
  /** Injectable fs.existsSync for testing. */
  existsSyncImpl?: (path: string) => boolean;
}

/**
 * Resolves a module path by checking custom/<path> before falling back to the
 * built-in package root. Enables per-workspace overrides without patching the
 * runner image.
 *
 * resolveModule('pipelines/autonomous.yml')
 *   → custom/pipelines/autonomous.yml   (if present in customRoot)
 *   → <package-root>/pipelines/autonomous.yml  (fallback)
 */
export function resolveModule(modulePath: string, options?: ResolveModuleOptions): string {
  const existsSyncFn = options?.existsSyncImpl ?? existsSync;
  const customRoot = options?.customRoot ?? process.cwd();
  const builtinRoot = options?.builtinRoot ?? BUILTIN_ROOT;

  const customPath = join(customRoot, "custom", modulePath);
  if (existsSyncFn(customPath)) return customPath;
  return join(builtinRoot, modulePath);
}

export interface ImportModuleOptions {
  /** Root directory to look for custom/ overrides. Defaults to process.cwd(). */
  customRoot?: string;
  /** Injectable fs.existsSync for testing. */
  existsSyncImpl?: (path: string) => boolean;
  /** Injectable import function for testing. Receives a file:// URL string. */
  importFn?: (url: string) => Promise<unknown>;
}

export function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  // ERR_UNKNOWN_FILE_EXTENSION lets a .ts file silently skip in a compiled-JS
  // runtime without a TypeScript loader; today we run under tsx so .ts imports
  // succeed, but this keeps the resolver safe if that ever changes.
  return (
    err.code === "MODULE_NOT_FOUND" ||
    err.code === "ERR_MODULE_NOT_FOUND" ||
    err.code === "ERR_UNKNOWN_FILE_EXTENSION"
  );
}

async function tryImportDefault<T>(
  absPath: string,
  importFn?: (url: string) => Promise<unknown>,
): Promise<T | null> {
  const fn = importFn ?? ((url: string) => import(url));
  try {
    const mod = await fn(pathToFileURL(absPath).href);
    return ((mod as { default?: T }).default ?? null) as T | null;
  } catch (err) {
    if (isModuleNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Dynamically imports a module by checking custom/<path>.{ts,js,mjs} first,
 * returning the default export. Returns null when no custom override exists —
 * the caller is responsible for providing the built-in fallback.
 *
 * This is the single resolver used for all dynamic module loading (steps,
 * providers, etc.). Path-based: no per-module-type discovery logic.
 *
 * resolveModuleImport("steps/implement")
 *   → imports custom/steps/implement.ts (or .js) and returns its default export
 *   → null if no custom override exists (caller uses built-in)
 */
export async function resolveModuleImport<T>(
  modulePath: string,
  options?: ImportModuleOptions,
): Promise<T | null> {
  const existsSyncFn = options?.existsSyncImpl ?? existsSync;
  const customRoot = options?.customRoot ?? process.cwd();

  for (const ext of [".ts", ".js", ".mjs"]) {
    const customPath = join(customRoot, "custom", `${modulePath}${ext}`);
    if (!existsSyncFn(customPath)) continue;
    const mod = await tryImportDefault<T>(customPath, options?.importFn);
    if (mod !== null) return mod;
    // File existed but produced no default export. A named-only export is
    // almost certainly a mistake — warn loudly rather than silently using the
    // built-in.
    console.warn(
      `resolveModuleImport: ${customPath} exists but has no default export; ignoring`,
    );
  }
  return null;
}
