import { expect, it } from "vitest";
import { stardogWaitOptions } from "../restate/kg-refresh-workflow.js";

it("keeps the production Stardog poll pause at 30 seconds and bounds retries to 20 minutes", () => {
  expect(stardogWaitOptions(30_000)).toEqual({
    maxRetryDuration: 1_200_000, initialRetryInterval: 30_000,
    maxRetryInterval: 30_000, retryIntervalFactor: 1,
  });
});

// Inspect the call sites as well as the helper so a correct but unused policy
// cannot satisfy this contract.
it("supplies the import, wait and verify policies to the saved steps", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../restate/kg-refresh-workflow.ts", import.meta.url), "utf8");
  const importStep = source.slice(source.indexOf('const imported = await ctx.run("stardog-import"'), source.indexOf('ctx.console.log(`stardog import started'));
  expect(importStep).toMatch(/}, \{ maxRetryAttempts: 1 \}\)/);
  const waitStep = source.slice(source.indexOf('const event = await ctx.run("stardog-wait"'), source.indexOf('if (event !== "done")'));
  expect(waitStep).toContain('readEvents(imported.kitId, imported.publishId, { maxMs: 4 * 60 * 1000 })');
  expect(waitStep).toContain('}, stardogWaitOptions(deps.stardogPollMs ?? 30_000, deps.stardogWaitBudgetMs))');
  const verifyStep = source.slice(source.indexOf('const count = await ctx.run("stardog-verify"'), source.indexOf('ctx.console.log(`stardog triples'));
  expect(verifyStep).toMatch(/}, \{ maxRetryAttempts: 3 \}\)/);
});
