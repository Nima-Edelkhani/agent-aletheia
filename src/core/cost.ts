/**
 * Cost estimation from token usage. Prices in USD per million tokens.
 *
 * NOTE: Public price list, kept in code for offline calculation. Update
 * as pricing changes. Cache-hit inputs are billed at a discount.
 */

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface Price {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

const PRICES: Record<string, Price> = {
  // Claude 4.x — Opus / Sonnet / Haiku
  "claude-opus-4-7":               { input: 15,  output: 75,  cache_write: 18.75, cache_read: 1.50 },
  "claude-opus-4-6":               { input: 15,  output: 75,  cache_write: 18.75, cache_read: 1.50 },
  "claude-sonnet-4-6":             { input: 3,   output: 15,  cache_write: 3.75,  cache_read: 0.30 },
  "claude-sonnet-4-5":             { input: 3,   output: 15,  cache_write: 3.75,  cache_read: 0.30 },
  "claude-haiku-4-5-20251001":     { input: 1,   output: 5,   cache_write: 1.25,  cache_read: 0.10 },
  "claude-haiku-4-5":              { input: 1,   output: 5,   cache_write: 1.25,  cache_read: 0.10 },
};

const FALLBACK: Price = { input: 3, output: 15, cache_write: 3.75, cache_read: 0.30 };

export function usageToCost(usage: TokenUsage | undefined, model: string): number {
  if (!usage) return 0;
  const price = PRICES[model] ?? FALLBACK;
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const cost =
    (inp * price.input +
      out * price.output +
      cw * price.cache_write +
      cr * price.cache_read) /
    1_000_000;
  return round6(cost);
}

export function sum(nums: number[]): number {
  return round6(nums.reduce((a, b) => a + b, 0));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
