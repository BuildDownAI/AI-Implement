import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignModelAbTestRow, modelAbTest, type ModelAbTestRow } from "../../restate/model-ab-test.js";
import { VARIANTS, callObject, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

describe("ModelAbTest project assignments", () => {
  let environments: Map<string, RestateEnvironment>;
  beforeAll(async () => { environments = await startVariants([modelAbTest]); }, 60_000);
  afterAll(async () => { await stopAll(environments); });

  for (const [variant] of VARIANTS) describe(variant, () => {
    const env = () => environments.get(variant)!;
    const assign = (project: string, issueId: string) =>
      callObject<ModelAbTestRow>(env().baseUrl(), "ModelAbTest", project, "assign", { issueId });

    it("alternates ten sequential issues in strict turn", async () => {
      const project = randomUUID();
      const rows = [];
      for (let i = 0; i < 10; i++) rows.push(await assign(project, String(i)));
      expect(rows).toEqual(Array.from({ length: 10 }, (_, i) => i % 2 === 0 ? "first" : "second"));
    });

    it("keeps an issue's row without consuming another turn or colliding with the counter", async () => {
      const project = randomUUID();
      expect(await assign(project, "turn")).toBe("first");
      expect(await assign(project, "turn")).toBe("first");
      expect(await assign(project, "next")).toBe("second");
      expect(await assign(project, "next")).toBe("second");
      expect(await assign(project, "issue:turn")).toBe("first");
    });

    it("serializes ten concurrent assignments into five of each row", async () => {
      const project = randomUUID();
      const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => assign(project, String(i))));
      expect(rows.filter(row => row === "first")).toHaveLength(5);
      expect(rows.filter(row => row === "second")).toHaveLength(5);
    });

    it("keeps projects' turns independent, including the same issue id", async () => {
      const first = randomUUID();
      const second = randomUUID();
      expect(await assign(first, "same")).toBe("first");
      expect(await assign(first, "other")).toBe("second");
      expect(await assign(second, "same")).toBe("first");
      expect(await assign(second, "other")).toBe("second");
    });

    it("returns rows through the real ingress client and forwards replacement fetch", async () => {
      const project = randomUUID();
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        requests.push(String(input));
        return fetch(input, init);
      };
      const deps = { baseUrl: env().baseUrl(), fetchImpl };
      expect(await assignModelAbTestRow(project, "one", deps)).toBe("first");
      expect(await assignModelAbTestRow(project, "two", deps)).toBe("second");
      expect(requests).toHaveLength(2);
      expect(requests.every(url => url.startsWith(`${deps.baseUrl}/ModelAbTest/`))).toBe(true);
    });
  });
});
