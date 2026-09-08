import { beforeEach } from "vitest";

// A dispatched runner container sets these in the environment, and npm test
// inside that container inherits them. Deleting unconditionally (not vi.stubEnv)
// avoids the stub stack: vi.unstubAllEnvs() in afterEach hooks cannot restore
// a live credential that was never stubbed, only deleted.
beforeEach(() => {
  delete process.env.RUN_TOKEN;
  delete process.env.RUNNER_CALLBACK_URL;
  delete process.env.RUN_PROGRESS_TOKEN;
  delete process.env.RUN_PUBLICATION_TOKEN;
  delete process.env.GIT_KG_PUSH_TOKEN_FILE;
});
