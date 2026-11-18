import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateCallCostUsd } from "../model-price-estimate.js";
import type { ModelPrice } from "../restate/model-prices.js";

const prices: ModelPrice[] = JSON.parse(readFileSync(new URL("./fixtures/contracts/model-prices/several-models.json", import.meta.url), "utf8")).response.body.prices;
const call = { model: "a-dated", tokensIn: 100, tokensOut: 10 };
describe("estimateCallCostUsd", () => {
  it.each([
    [call, 0.00031234567890123456789],
    [{ ...call, cacheReadTokens: 20, cacheCreationTokens: 30 }, 0.000281172839450617283945],
    [{ ...call, cacheReadTokens: 200, cacheCreationTokens: 30 }, 0.000175],
    [{ ...call, tokensIn: 0, tokensOut: 0 }, 0],
    [{ ...call, model: "unknown" }, null],
    [{ ...call, tokensIn: null }, null],
    [{ ...call, tokensOut: null }, null],
  ])("prices %j using recorded base rates", (input, expected) => {
    expect(estimateCallCostUsd(input, prices)).toBe(expected);
  });
  it("returns null without prices", () => expect(estimateCallCostUsd(call, [])).toBeNull());
});
