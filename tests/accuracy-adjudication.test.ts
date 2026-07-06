import { describe, it, expect } from "vitest";
import type { AccuracyAdjudication } from "../src/core/types";

/**
 * Structural sanity checks for the AccuracyAdjudication shape emitted by
 * the LLM judge. The judge itself makes a real API call, so we don't
 * regression-test it here — we test that any consumer (UI card, evals,
 * trace dump) can rely on the shape it receives.
 */
describe("AccuracyAdjudication shape", () => {
  const example: AccuracyAdjudication = {
    reference_supports_summary: {
      pass: true,
      reason: "quote clearly expresses the finding",
    },
    summary_addresses_question: {
      pass: true,
      reason: "on-topic for the rescoped question",
    },
    category_is_sensible: {
      pass: false,
      reason: "'misc' is generic and does not describe the finding",
    },
    overall_pass: false,
    cost_estimate: 0.00123,
    model: "claude-haiku-4-5-20251001",
  };

  it("has three named check fields, each with pass + reason", () => {
    expect(example.reference_supports_summary).toEqual(
      expect.objectContaining({ pass: expect.any(Boolean), reason: expect.any(String) }),
    );
    expect(example.summary_addresses_question).toEqual(
      expect.objectContaining({ pass: expect.any(Boolean), reason: expect.any(String) }),
    );
    expect(example.category_is_sensible).toEqual(
      expect.objectContaining({ pass: expect.any(Boolean), reason: expect.any(String) }),
    );
  });

  it("overall_pass matches the AND of the three sub-checks", () => {
    const allPass: AccuracyAdjudication = {
      ...example,
      reference_supports_summary: { pass: true, reason: "yes" },
      summary_addresses_question: { pass: true, reason: "yes" },
      category_is_sensible: { pass: true, reason: "yes" },
      overall_pass:
        true && true && true, // documented invariant
    };
    expect(allPass.overall_pass).toBe(true);

    const oneFail: AccuracyAdjudication = {
      ...example,
      overall_pass:
        example.reference_supports_summary.pass &&
        example.summary_addresses_question.pass &&
        example.category_is_sensible.pass,
    };
    expect(oneFail.overall_pass).toBe(false);
  });

  it("carries cost_estimate and model for trace / eval reporting", () => {
    expect(typeof example.cost_estimate).toBe("number");
    expect(example.model).toMatch(/haiku|sonnet|opus/);
  });

  it("reasons are always populated — even on pass", () => {
    const allPass: AccuracyAdjudication = {
      reference_supports_summary: { pass: true, reason: "..." },
      summary_addresses_question: { pass: true, reason: "..." },
      category_is_sensible: { pass: true, reason: "..." },
      overall_pass: true,
      cost_estimate: 0,
      model: "claude-haiku-4-5-20251001",
    };
    // The judge contract requires non-empty reasons everywhere; the type
    // system enforces `string`, and the LLM prompt reinforces "always
    // populate". This test documents the invariant so a reader knows to
    // preserve it if they touch the judge prompt.
    expect(allPass.reference_supports_summary.reason.length).toBeGreaterThan(0);
    expect(allPass.summary_addresses_question.reason.length).toBeGreaterThan(0);
    expect(allPass.category_is_sensible.reason.length).toBeGreaterThan(0);
  });
});
