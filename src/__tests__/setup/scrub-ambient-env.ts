// Listed first in the setupFiles of both vitest.config.ts and vitest.restate.config.ts.
// Every later setup file, and the test file itself, then starts from the allowlisted environment.
import { afterAll, expect, inject } from "vitest";
import { BASE_ENV_ALLOWLIST, scrubAmbientEnv } from "./ambient-env.js";
import { endFileTempRoot, startFileTempRoot } from "./run-temp-root.js";

const runTempRoot = inject("runTempRoot");
if (!runTempRoot) {
  throw new Error("No run temp directory was provided: list src/__tests__/setup/run-temp-root.ts in the config's globalSetup.");
}
const fileTempRoot = startFileTempRoot(runTempRoot, expect.getState().testPath ?? "unknown-test-file");
scrubAmbientEnv(BASE_ENV_ALLOWLIST, fileTempRoot);
// Registered before the test file's hooks, so it runs after the file's own afterAll hooks have removed what their beforeAll created.
afterAll(() => endFileTempRoot(fileTempRoot));
