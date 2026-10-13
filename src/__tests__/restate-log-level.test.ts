// Default suite, no Docker. The Restate SDK log level the scenario runs pass to the SDK
// (vitest.restate.config.ts). Two edge cases found in the review of PR #956: an unknown name
// made the SDK throw at module load in every fork, and an empty value fell through `??` to the
// SDK's INFO default instead of the WARN default the config documents.
import { describe, expect, it, vi } from "vitest";
import { RESTATE_LOG_LEVELS, resolveRestateLogLevel } from "../restate/log-level.js";

describe("resolveRestateLogLevel", () => {
  it("defaults to WARN when the variable is unset, empty, or blank", () => {
    const warn = vi.fn();
    expect(resolveRestateLogLevel(undefined, warn)).toBe("WARN");
    expect(resolveRestateLogLevel("", warn)).toBe("WARN");
    expect(resolveRestateLogLevel("   ", warn)).toBe("WARN");
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts each SDK level name in any case and returns it upper-cased", () => {
    const warn = vi.fn();
    for (const level of RESTATE_LOG_LEVELS) {
      expect(resolveRestateLogLevel(level, warn)).toBe(level);
      expect(resolveRestateLogLevel(level.toLowerCase(), warn)).toBe(level);
      expect(resolveRestateLogLevel(` ${level} `, warn)).toBe(level);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to WARN on an unknown name and says so once, naming the valid names", () => {
    const warn = vi.fn();
    expect(resolveRestateLogLevel("off", warn)).toBe("WARN");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("RESTATE_LOGGING");
    expect(message).toContain("off");
    for (const level of RESTATE_LOG_LEVELS) expect(message).toContain(level);
  });

  it("lists exactly the five names the SDK's console transport accepts", () => {
    expect([...RESTATE_LOG_LEVELS]).toEqual(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
  });
});
