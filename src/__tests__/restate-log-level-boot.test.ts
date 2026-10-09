// Default suite, no Docker. The boot module sets the SDK's log level before the SDK loads
// (AII-1189), so src/index.ts must import it first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("src/index.ts import order", () => {
  it("imports ./restate/log-level-boot.js before any other import", () => {
    const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const first = /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/m.exec(withoutComments);
    expect(first?.[1]).toBe("./restate/log-level-boot.js");
  });
});

describe("log-level-boot", () => {
  const original = process.env.RESTATE_LOGGING;

  afterEach(() => {
    if (original === undefined) delete process.env.RESTATE_LOGGING;
    else process.env.RESTATE_LOGGING = original;
    vi.restoreAllMocks();
  });

  it("resolves empty and unknown values to WARN and keeps a known level", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: Array<[string, string, number]> = [
      ["", "WARN", 0],
      ["off", "WARN", 1],
      ["debug", "DEBUG", 0],
    ];
    for (const [input, expected, warnings] of cases) {
      warn.mockClear();
      vi.resetModules();
      process.env.RESTATE_LOGGING = input;
      await import("../restate/log-level-boot.js");
      expect(process.env.RESTATE_LOGGING).toBe(expected);
      expect(warn).toHaveBeenCalledTimes(warnings);
    }
  });
});
