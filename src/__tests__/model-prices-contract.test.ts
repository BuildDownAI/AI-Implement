import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelPricesResponseSchema } from "../restate/model-prices.js";

const root = new URL("./fixtures/contracts/model-prices/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root));
const lock = JSON.parse(read("contracts.lock.json").toString()) as {
  repo: string; commit: string; files: Record<string, string>;
};
const producerSchema = z.fromJSONSchema(JSON.parse(read("response.schema.json").toString()));

describe("pinned Control-Plane model price contract", () => {
  it("locks all four producer files", () => {
    expect(lock.repo).toBe("BuildDownAI/Control-Plane");
    expect(lock.commit).toBe("545a6c4");
    expect(Object.keys(lock.files).sort()).toEqual([
      "empty.json", "response.schema.json", "several-models.json", "unavailable.json",
    ]);
    for (const [name, hash] of Object.entries(lock.files)) {
      expect(createHash("sha256").update(read(name)).digest("hex"), name).toBe(hash);
    }
  });

  for (const name of ["several-models.json", "empty.json", "unavailable.json"]) {
    const { response } = JSON.parse(read(name).toString());
    if (response.status !== 200) continue;
    it(`validates ${name} against producer and consumer schemas without changing values`, () => {
      expect(producerSchema.parse(response.body)).toEqual(response.body);
      expect(modelPricesResponseSchema.parse(response.body)).toEqual(response.body);
    });
  }

  it("rejects dates outside the producer timestamp pattern", () => {
    const { response } = JSON.parse(read("several-models.json").toString());
    response.body.prices[0].effectiveFrom = "not-a-timestamp";
    expect(producerSchema.safeParse(response.body).success).toBe(false);
    expect(modelPricesResponseSchema.safeParse(response.body).success).toBe(false);
  });
});
