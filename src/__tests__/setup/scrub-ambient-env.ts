// Listed first in the setupFiles of both vitest.config.ts and vitest.restate.config.ts.
// Every later setup file, and the test file itself, then starts from the allowlisted environment.
import { BASE_ENV_ALLOWLIST, scrubAmbientEnv } from "./ambient-env.js";

scrubAmbientEnv(BASE_ENV_ALLOWLIST);
