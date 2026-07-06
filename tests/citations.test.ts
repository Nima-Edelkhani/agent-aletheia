import { describe, it, expect } from "vitest";
import {
  citationsToMarkdownLinks,
  extractCitedIndices,
} from "../src/core/citations";

describe("citationsToMarkdownLinks", () => {
  it("rewrites a single citation into a markdown link", () => {
    expect(citationsToMarkdownLinks("Fintrust raised pricing[s1].")).toBe(
      "Fintrust raised pricing[s1](#signal-1).",
    );
  });

  it("rewrites chained citations independently", () => {
    expect(
      citationsToMarkdownLinks("Two customers concurred[s1][s3]."),
    ).toBe("Two customers concurred[s1](#signal-1)[s3](#signal-3).");
  });

  it("handles multi-digit indices", () => {
    expect(citationsToMarkdownLinks("A finding[s12].")).toBe(
      "A finding[s12](#signal-12).",
    );
  });

  it("leaves non-citation brackets alone", () => {
    expect(
      citationsToMarkdownLinks(
        "See [the docs](https://example.com) — not a citation.",
      ),
    ).toBe("See [the docs](https://example.com) — not a citation.");
  });

  it("does not match [S1] (case-sensitive)", () => {
    // The aggregator contract requires lowercase `s`. Uppercase should
    // stay as literal text so the drift shows up in output.
    expect(citationsToMarkdownLinks("Wrong case: [S1].")).toBe(
      "Wrong case: [S1].",
    );
  });

  it("does not match [s] with no number", () => {
    expect(citationsToMarkdownLinks("Just brackets [s].")).toBe(
      "Just brackets [s].",
    );
  });

  it("returns empty string unchanged", () => {
    expect(citationsToMarkdownLinks("")).toBe("");
  });

  it("preserves surrounding markdown formatting", () => {
    expect(
      citationsToMarkdownLinks("**Bold**[s2] and _italic_[s5] survive."),
    ).toBe("**Bold**[s2](#signal-2) and _italic_[s5](#signal-5) survive.");
  });
});

describe("extractCitedIndices", () => {
  it("returns each cited index once, in first-appearance order", () => {
    expect(
      extractCitedIndices("A[s3], B[s1], C[s3], D[s1], E[s2]."),
    ).toEqual([3, 1, 2]);
  });

  it("returns [] when no citations present", () => {
    expect(extractCitedIndices("No claims here.")).toEqual([]);
  });

  it("ignores non-citation brackets", () => {
    expect(
      extractCitedIndices("Link: [click](https://ex.com) plus [s7]."),
    ).toEqual([7]);
  });
});
