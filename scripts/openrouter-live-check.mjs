import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPENROUTER_HOST = "https://openrouter.ai";

export async function runOpenRouterLiveCheck({
  key = process.env.OPENROUTER_TEST_API_KEY,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  let result = "skipped (no key)";
  if (key) {
    try {
      // Key information only: no generation, request body, or redirect to another host.
      const response = await fetchImpl(`${OPENROUTER_HOST}/api/v1/key`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const status = response.status;
      result = status >= 200 && status < 300
        ? "pass"
        : status === 401 || status === 403
          ? `fail (key refused, status ${status})`
          : `fail (status ${status})`;
    } catch {
      // Never log exceptions: they can contain credentials or request headers.
      result = "fail (no answer)";
    }
  }
  log(`openrouter-live-check: ${result}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOpenRouterLiveCheck();
}
