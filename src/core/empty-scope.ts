import { formatWindow, type TimeWindow } from "./time-window";

/**
 * Chooses the answer text for a run that left NO documents in scope, so the
 * orchestrator can short-circuit (no sub-agents, no aggregate call). The
 * message distinguishes three causes so the user gets an honest, specific
 * answer instead of a generic "no evidence":
 *
 *   1. empty knowledge base           — nothing to search at all
 *   2. a time filter emptied the scope — the requested window has no meetings
 *   3. any other empty scope           — filters matched nothing
 *
 * Pure and deterministic (branches only on kb size + the resolved window), so
 * it's unit-tested in `tests/empty-scope.test.ts` and CI-gated.
 */
export interface EmptyScopeMessage {
  response_text: string;
  response_reasoning: string;
}

export function pickEmptyScopeMessage(
  kbSize: number,
  timeFilter: TimeWindow | null,
): EmptyScopeMessage {
  if (kbSize === 0) {
    return {
      response_text:
        "The knowledge base is empty — there are no documents to search.",
      response_reasoning:
        "The filter step found no documents in the knowledge base, so no sub-agents ran.",
    };
  }

  if (timeFilter !== null) {
    const window = formatWindow(timeFilter);
    return {
      response_text:
        `No meetings in the knowledge base fall within the requested time ` +
        `window (${window}). Aletheia did not search any documents. The ` +
        `knowledge base has ${kbSize} document(s), but none are dated ${window}.`,
      response_reasoning:
        `The question is time-scoped to ${window}. After deterministically ` +
        `applying that window to every document's date, no document qualified, ` +
        `so the fan-out was skipped entirely.`,
    };
  }

  return {
    response_text:
      "No documents matched the filters for this question, so Aletheia did " +
      "not search any documents.",
    response_reasoning:
      "The filter step returned an empty scope for a question with no time " +
      "window, so no sub-agents ran.",
  };
}
