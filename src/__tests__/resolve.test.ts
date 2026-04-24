import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveModule } from "../resolve.js";

const PROJECT_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const builtinUrl = (p: string) => pathToFileURL(join(PROJECT_ROOT, p)).href;
const customUrl = (p: string) => pathToFileURL(join(PROJECT_ROOT, "custom", p)).href;

const fixture = { default: "value" };

function makeImport(available: Record<string, unknown>) {
  return async (path: string) => {
    if (path in available) return available[path];
    const err = new Error(`Cannot find module '${path}'`) as NodeJS.ErrnoException;
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  };
}

describe("resolveModule", () => {
  it("resolves built-in when no custom exists", async () => {
    const result = await resolveModule<typeof fixture>("steps/clone.js", makeImport({
      [builtinUrl("steps/clone.js")]: fixture,
    }));
    expect(result).toBe(fixture);
  });

  it("resolves custom when it exists, ignoring built-in", async () => {
    const custom = { default: "custom" };
    const result = await resolveModule<typeof custom>("steps/clone.js", makeImport({
      [customUrl("steps/clone.js")]: custom,
      [builtinUrl("steps/clone.js")]: fixture,
    }));
    expect(result).toBe(custom);
  });

  it("throws with both paths when neither exists", async () => {
    await expect(
      resolveModule("steps/missing.js", makeImport({})),
    ).rejects.toThrow(
      `Module not found: tried ${customUrl("steps/missing.js")} and ${builtinUrl("steps/missing.js")}`,
    );
  });

  it("re-throws non-'not found' errors from the custom module", async () => {
    const loadError = new SyntaxError("Unexpected token");
    const importImpl = async (path: string) => {
      if (path === customUrl("steps/broken.js")) throw loadError;
      return fixture;
    };
    await expect(resolveModule("steps/broken.js", importImpl)).rejects.toBe(loadError);
  });
});
