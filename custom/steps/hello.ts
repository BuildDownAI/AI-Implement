/**
 * Example custom step — demonstrates the module contract for custom/steps/ auto-loading.
 *
 * Place a file here (custom/steps/<name>.ts or .js) and reference it by name in your
 * pipeline YAML as:
 *
 *   - id: my-step
 *     type: custom
 *     moduleId: hello
 *
 * The runner discovers it automatically via resolveModule('steps/hello').
 * The module MUST export a default that satisfies the StepModule interface.
 */

import type { StepModule } from "../../src/pipeline/types.js";

export default {
  async run(_context, _inputs, _reporter) {
    return { message: "hello from custom step" };
  },
} satisfies StepModule;
