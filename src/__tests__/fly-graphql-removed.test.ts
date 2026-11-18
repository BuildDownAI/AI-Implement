import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps the retired Fly GraphQL endpoint out of src", () => {
  const result = spawnSync("git", ["grep", "-n", "-F", "api.fly.io/graphql", "--", "src", ":!src/__tests__/fly-graphql-removed.test.ts"], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.stdout).toBe("");
  expect(result.status).toBe(1);
});
