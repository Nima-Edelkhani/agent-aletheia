/**
 * Pure logic for the accuracy judge's verdict. Extracted from
 * `src/core/subagent.ts` (an LLM module) so the invariant can be unit-tested
 * and CI-gated independently of any API call.
 */

/** The minimal shape needed to decide overall pass — just the three verdicts. */
export interface ThreeChecks {
  reference_supports_summary: { pass: boolean };
  summary_addresses_question: { pass: boolean };
  category_is_sensible: { pass: boolean };
}

/**
 * A signal passes overall ONLY if all three independent checks pass — a strict
 * logical AND. This is the single source of truth for that invariant; the
 * judge in `subagent.ts` calls it, and the UI/eval consumers rely on
 * `overall_pass` mirroring it.
 */
export function overallPass(checks: ThreeChecks): boolean {
  return (
    checks.reference_supports_summary.pass &&
    checks.summary_addresses_question.pass &&
    checks.category_is_sensible.pass
  );
}
