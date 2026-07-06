import type { AletheiaConfig, Signal } from "./types";

export interface DroppedSignalEntry {
  reason: string;
  signal: Signal;
}

/**
 * Step 6 of the orchestrator loop — takes the flat list of signals emitted
 * by every sub-agent and applies two threshold gates:
 *   1. If `accuracy_pass_enforced` is set, drop any signal whose
 *      `accuracy_pass` is false.
 *   2. Drop any signal whose `ref_fuzzy_distance` is below the cutoff.
 * `no-signal` entries pass through untouched — they're documentation, not
 * assertions, and the aggregator uses them to see what was searched.
 *
 * Returns:
 *   - `keptSignals`: what makes it into `response.signals` (PRD contract).
 *   - `droppedSignals`: preserved for the trace so `--debug` can show them.
 *   - `filteringReasoning`: human-readable explanation of what was dropped
 *      and why. Fed into `response.filtering_reasoning`.
 */
export function filterSignals(
  rawSignals: Signal[],
  config: AletheiaConfig,
): {
  keptSignals: Signal[];
  droppedSignals: DroppedSignalEntry[];
  filteringReasoning: string;
} {
  const dropped: DroppedSignalEntry[] = [];
  const kept: Signal[] = [];

  for (const s of rawSignals) {
    if (s.signal_type === "no-signal") {
      kept.push(s);
      continue;
    }
    if (config.accuracy_pass_enforced && !s.accuracy_pass) {
      dropped.push({ signal: s, reason: "failed accuracy check" });
      continue;
    }
    if (s.ref_fuzzy_distance < config.ref_fuzzy_distance_cutoff) {
      dropped.push({
        signal: s,
        reason: `ref_fuzzy_distance=${s.ref_fuzzy_distance} below cutoff=${config.ref_fuzzy_distance_cutoff}`,
      });
      continue;
    }
    if (s.confidence < config.confidence_cutoff) {
      dropped.push({
        signal: s,
        reason: `confidence=${s.confidence.toFixed(2)} below cutoff=${config.confidence_cutoff}`,
      });
      continue;
    }
    kept.push(s);
  }

  const filteringReasoning =
    dropped.length === 0
      ? "No signals were filtered out."
      : `Filtered out ${dropped.length} signal(s): ${dropped
          .map((d) => `${d.signal.id}: ${d.reason}`)
          .join("; ")}.`;

  return { keptSignals: kept, droppedSignals: dropped, filteringReasoning };
}
