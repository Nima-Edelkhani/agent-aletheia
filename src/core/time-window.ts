import type { DocMeta } from "./types";

/**
 * Deterministic date-window filtering for the orchestrator's filter step.
 *
 * The filter LLM resolves a natural-language time expression ("last 2 months",
 * "since March", "Q1") into a `TimeWindow` — a language task it's good at. The
 * actual inclusion/exclusion of documents is then done HERE, in pure code, so
 * the model can never over-include a stale document by fuzzing the date math.
 *
 * These are pure, side-effect-free functions with no LLM or I/O — hence unit
 * tested in `tests/time-window.test.ts` and gated in CI.
 */

/**
 * An absolute, resolved date window. `start`/`end` are inclusive ISO
 * `YYYY-MM-DD` bounds; `null` means the bound is open on that side. The whole
 * object is `null` when the question carries no time constraint.
 */
export interface TimeWindow {
  start: string | null;
  end: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerces a value to a valid `YYYY-MM-DD` string, or null if it isn't one. */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

/**
 * Sanitizes the LLM-provided window: keeps only valid ISO bounds, and
 * collapses a window with two invalid/absent bounds to `null` (no filter).
 */
export function normalizeTimeWindow(raw: TimeWindow | null): TimeWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const start = toIsoDate(raw.start);
  const end = toIsoDate(raw.end);
  if (start === null && end === null) return null;
  return { start, end };
}

/**
 * Applies an inclusive `[start, end]` window (either bound may be open) to a
 * candidate scope. A doc survives only if its `metadata.date` is a valid ISO
 * date inside the window. Docs with a missing/unparseable date are dropped
 * whenever a window is active — a time-scoped question cannot be satisfied by
 * a doc whose date we can't verify. Returns the surviving scope plus the list
 * of dropped IDs for tracing. ISO `YYYY-MM-DD` strings sort lexicographically,
 * so plain string comparison is a correct date comparison here.
 */
export function applyTimeWindow(
  candidateIds: string[],
  metadata: DocMeta[],
  window: TimeWindow | null,
): { scope: string[]; excluded: string[] } {
  if (window === null) return { scope: candidateIds, excluded: [] };

  const dateById = new Map(
    metadata.map((m) => [m.id, toIsoDate((m.metadata as Record<string, unknown>).date)]),
  );

  const scope: string[] = [];
  const excluded: string[] = [];
  for (const id of candidateIds) {
    const date = dateById.get(id) ?? null;
    const inWindow =
      date !== null &&
      (window.start === null || date >= window.start) &&
      (window.end === null || date <= window.end);
    if (inWindow) scope.push(id);
    else excluded.push(id);
  }
  return { scope, excluded };
}

/** Human-readable label for a resolved window, for reasoning/answer text. */
export function formatWindow(window: TimeWindow | null): string {
  if (window === null) return "any date";
  if (window.start && window.end) return `${window.start} to ${window.end}`;
  if (window.start) return `on or after ${window.start}`;
  if (window.end) return `on or before ${window.end}`;
  return "any date";
}
