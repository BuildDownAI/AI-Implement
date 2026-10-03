// Listed first in vitest.config.ts's setupFiles.
// Every later setup file, and the test file itself, then starts from the allowlisted environment.
import { BASE_ENV_ALLOWLIST, scrubAmbientEnv } from "./ambient-env.js";

scrubAmbientEnv(BASE_ENV_ALLOWLIST);
