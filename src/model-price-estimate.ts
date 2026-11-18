/** Per-token base rates supplied by the control plane's model-price catalog. */
export interface ModelPriceRates {
  model: string;
  inputUsd: string;
  outputUsd: string;
  cacheReadUsd: string;
  cacheWriteUsd: string;
}

/** Estimate at base per-token rates, preserving decimal precision until the result. */
export function estimateCallCostUsd(
  call: { model: string; tokensIn: number | null; tokensOut: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null },
  prices: readonly ModelPriceRates[],
): number | null {
  const price = prices.find(p => p.model === call.model);
  if (!price || call.tokensIn === null || call.tokensOut === null) return null;
  const read = call.cacheReadTokens ?? 0;
  const write = call.cacheCreationTokens ?? 0;
  const uncached = [BigInt(call.tokensIn) - BigInt(read) - BigInt(write), 0n].reduce((a, b) => a > b ? a : b);
  const rates = [price.inputUsd, price.cacheReadUsd, price.cacheWriteUsd, price.outputUsd];
  const scale = Math.max(...rates.map(rate => (rate.split(".")[1] ?? "").length));
  const counts = [uncached, BigInt(read), BigInt(write), BigInt(call.tokensOut)];
  const total = rates.reduce((sum, rate, i) => {
    const [whole, fraction = ""] = rate.split(".");
    return sum + BigInt(whole + fraction.padEnd(scale, "0")) * counts[i]!;
  }, 0n);
  // Parse the exact decimal once, avoiding rounding a numerator before division.
  const digits = total.toString().padStart(scale + 1, "0");
  return Number(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
