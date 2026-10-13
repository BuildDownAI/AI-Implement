// The Restate SDK's console transport reads `RESTATE_LOGGING` at module load
// (node_modules/@restatedev/restate-sdk/dist/logging/console_logger_transport.js,
// `readRestateLogLevel`): a known name sets the level, an empty value falls back to the SDK's
// INFO default, and any other name throws a TypeError from the module that imports the SDK.
// The scenario runs set the variable from vitest.restate.config.ts, so the value is resolved
// here first: a bad name cannot crash every vitest fork at import, and an empty value keeps
// the WARN default the config documents (review of PR #956, AII-1161).

/** The five names the SDK accepts, upper-cased, in the SDK's own order. */
export const RESTATE_LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

export type RestateLogLevel = (typeof RESTATE_LOG_LEVELS)[number];

export const DEFAULT_RESTATE_LOG_LEVEL: RestateLogLevel = "WARN";

/**
 * Resolves the value to pass to the SDK as `RESTATE_LOGGING`.
 *
 * - unset, empty, or blank: the default (`WARN`), silently;
 * - one of the five names in any case, with surrounding spaces: that name upper-cased;
 * - anything else: the default, and one `warn` line that names the rejected value and the
 *   accepted names, so the operator sees why the level did not change.
 */
export function resolveRestateLogLevel(
  raw: string | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
  fallback: RestateLogLevel = DEFAULT_RESTATE_LOG_LEVEL,
): RestateLogLevel {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  const upper = trimmed.toUpperCase();
  const match = RESTATE_LOG_LEVELS.find((level) => level === upper);
  if (match) return match;
  warn(
    `RESTATE_LOGGING=${JSON.stringify(raw)} is not a Restate SDK log level; using ${fallback}. ` +
      `Accepted names: ${RESTATE_LOG_LEVELS.join(", ")}.`,
  );
  return fallback;
}
