/** Machine metadata the dispatch step stamps and the reaper reads; one definition for both. A module of its own
 *  because `fly-machines.ts` stamps them and the Restate boundary forbids it importing `src/restate/`;
 *  `src/restate/fly-machine-profile.ts` re-exports them. */
export const DURABLE_RUNNER_PURPOSE_KEY = "purpose";
export const DURABLE_RUNNER_PURPOSE_VALUE = "durable-runner";
export const DURABLE_RUNNER_PIPELINE_KEY = "pipeline";
export const DURABLE_RUNNER_DISPATCH_ID_KEY = "dispatch_id";
