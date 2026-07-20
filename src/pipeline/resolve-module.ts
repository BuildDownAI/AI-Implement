import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two levels up from src/pipeline/ reaches the project root where pipelines/ lives.
const BUILTIN_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface ResolveModuleOptions {
  /** Root directory to look for custom/ overrides. Defaults to process.cwd(). */
  customRoot?: string;
  /**
   * Secondary root for custom/ overrides baked into the runner image — a
   * directory that CONTAINS a custom/ subdirectory (same shape as customRoot).
   * Defaults to the AI_IMPLEMENT_CUSTOM_ROOT env var. Checked after customRoot,
   * before the built-in.
   */
  bakedRoot?: string;
  /** Root directory for built-in files. Defaults to the package root. */
  builtinRoot?: string;
  /** Injectable fs.existsSync for testing. */
  existsSyncImpl?: (path: string) => boolean;
}

/**
 * Roots to search for custom/ overrides, in precedence order:
 *   1. customRoot (defaults to process.cwd()) — the workspace always wins.
 *   2. bakedRoot (defaults to env AI_IMPLEMENT_CUSTOM_ROOT) — overrides baked
 *      into the runner image at build time. In Dockerfile.session this is /app,
 *      i.e. the image's custom/ lives at /app/custom/. Skipped when unset or
 *      identical to customRoot.
 */
function customSearchRoots(options?: { customRoot?: string; bakedRoot?: string }): string[] {
  const customRoot = options?.customRoot ?? process.cwd();
  const bakedRoot = options?.bakedRoot ?? process.env.AI_IMPLEMENT_CUSTOM_ROOT;
  const roots = [customRoot];
  if (bakedRoot && bakedRoot !== customRoot) roots.push(bakedRoot);
  return roots;
}

/**
 * Resolves a module path by checking custom/<path> before falling back to the
 * built-in package root. Enables per-workspace overrides without patching the
 * runner image, and image-baked overrides (AI_IMPLEMENT_CUSTOM_ROOT) for forks
 * that build their own runner image.
 *
 * resolveModule('pipelines/autonomous.yml')
 *   → <customRoot>/custom/pipelines/autonomous.yml   (if present; customRoot defaults to cwd)
 *   → <bakedRoot>/custom/pipelines/autonomous.yml    (if present; bakedRoot defaults to env AI_IMPLEMENT_CUSTOM_ROOT)
 *   → <package-root>/pipelines/autonomous.yml        (fallback)
 */
export function resolveModule(modulePath: string, options?: ResolveModuleOptions): string {
  const existsSyncFn = options?.existsSyncImpl ?? existsSync;
  const builtinRoot = options?.builtinRoot ?? BUILTIN_ROOT;

  for (const root of customSearchRoots(options)) {
    const customPath = join(root, "custom", modulePath);
    if (existsSyncFn(customPath)) return customPath;
  }
  return join(builtinRoot, modulePath);
}

export interface ImportModuleOptions {
  /** Root directory to look for custom/ overrides. Defaults to process.cwd(). */
  customRoot?: string;
  /**
   * Secondary root for custom/ overrides baked into the runner image — a
   * directory that CONTAINS a custom/ subdirectory (same shape as customRoot).
   * Defaults to the AI_IMPLEMENT_CUSTOM_ROOT env var. Checked after customRoot,
   * before the built-in.
   */
  bakedRoot?: string;
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
 *     (workspace customRoot first, then the baked AI_IMPLEMENT_CUSTOM_ROOT)
 *   → null if no custom override exists (caller uses built-in)
 */
export async function resolveModuleImport<T>(
  modulePath: string,
  options?: ImportModuleOptions,
): Promise<T | null> {
  const existsSyncFn = options?.existsSyncImpl ?? existsSync;

  for (const root of customSearchRoots(options)) {
    for (const ext of [".ts", ".js", ".mjs"]) {
      const customPath = join(root, "custom", `${modulePath}${ext}`);
      if (!existsSyncFn(customPath)) continue;
      const mod = await tryImportDefault<T>(customPath, options?.importFn);
      if (mod !== null) return mod;
      // File existed but produced no default export. A named-only export is
      // almost certainly a mistake — warn loudly rather than silently using the
      // built-in (or the next root).
      console.warn(
        `resolveModuleImport: ${customPath} exists but has no default export; ignoring`,
      );
    }
  }
  return null;
}
