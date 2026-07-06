import { describe, it, expect } from "vitest";
import { usageToCost, sum } from "../src/core/cost.js";

describe("usageToCost", () => {
  it("computes cost with known model prices", () => {
    const cost = usageToCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      "claude-sonnet-4-6",
    );
    // Sonnet: $3 input + $15 output per 1M
    expect(cost).toBeCloseTo(18, 4);
  });

  it("includes cache read/write costs", () => {
    const cost = usageToCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
      "claude-sonnet-4-6",
    );
    // cache_write $3.75 + cache_read $0.30
    expect(cost).toBeCloseTo(4.05, 4);
  });

  it("falls back to Sonnet-like pricing for unknown model", () => {
    const cost = usageToCost({ input_tokens: 1_000_000 }, "unknown-model");
    expect(cost).toBeCloseTo(3, 4);
  });

  it("returns 0 for undefined usage", () => {
    expect(usageToCost(undefined, "claude-sonnet-4-6")).toBe(0);
  });
});

describe("sum", () => {
  it("sums a list of numbers with rounding", () => {
    expect(sum([0.1, 0.2, 0.3])).toBeCloseTo(0.6, 5);
  });
  it("handles empty list", () => {
    expect(sum([])).toBe(0);
  });
});
