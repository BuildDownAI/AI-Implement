// Listed first in vitest.restate.config.ts's setupFiles.
// Every later setup file, and the test file itself, then starts from the allowlisted environment.
import { RESTATE_ENV_ALLOWLIST, scrubAmbientEnv } from "./ambient-env.js";

scrubAmbientEnv(RESTATE_ENV_ALLOWLIST);
