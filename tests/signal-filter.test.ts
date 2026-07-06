import { describe, it, expect } from "vitest";
import { filterSignals } from "../src/core/signal-filter";
import type {
  AletheiaConfig,
  Signal,
  SignalSignal,
  SignalNoSignal,
} from "../src/core/types";

const CONFIG: AletheiaConfig = {
  accuracy_pass_enforced: true,
  ref_fuzzy_distance_cutoff: 80,
  confidence_cutoff: 0.5,
  timeouts_ms: {
    soft_at_percent_done: 90,
    soft_timeout_ms: 120000,
    hard_timeout_ms: 300000,
  },
  models: {
    filter: "claude-sonnet-4-6",
    rescope: "claude-sonnet-4-6",
    subagent: "claude-sonnet-4-6",
    accuracy_judge: "claude-haiku-4-5-20251001",
    aggregate: "claude-sonnet-4-6",
  },
  context_window: { before_max_chars: 1000, after_max_chars: 1000 },
};

function signal(overrides: Partial<SignalSignal>): SignalSignal {
  return {
    signal_type: "signal",
    scope_of_signal: "doc-a",
    question_rescoped: "Did the doc contain X?",
    payload_format: null,
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
    reference_text: "some quote",
    before_reference_text: "before",
    after_reference_text: "after",
    ref_fuzzy_distance: 100,
    confidence: 0.9,
    cost_estimate: 0,
    model: "claude-sonnet-4-6",
    accuracy_pass: true,
    finding_summary: "…",
    finding_category: "example",
    payload: {},
    accuracy_adjudication: null,
    ...overrides,
  };
}

function noSignal(scope = "doc-x"): SignalNoSignal {
  return {
    signal_type: "no-signal",
    scope_of_signal: scope,
    question_rescoped: "Did the doc contain X?",
    payload_format: null,
    id: `nosig-${scope}`,
    model: "claude-sonnet-4-6",
  };
}

describe("filterSignals — happy path", () => {
  it("keeps signals that pass accuracy and meet fuzz cutoff", () => {
    const signals: Signal[] = [
      signal({ id: "s1", accuracy_pass: true, ref_fuzzy_distance: 95 }),
      signal({ id: "s2", accuracy_pass: true, ref_fuzzy_distance: 85 }),
    ];
    const { keptSignals, droppedSignals, filteringReasoning } = filterSignals(
      signals,
      CONFIG,
    );
    expect(keptSignals).toHaveLength(2);
    expect(droppedSignals).toHaveLength(0);
    expect(filteringReasoning).toBe("No signals were filtered out.");
  });
});

describe("filterSignals — accuracy gate", () => {
  it("drops signals that failed accuracy when enforcement is on", () => {
    const bad = signal({ id: "s-bad", accuracy_pass: false });
    const good = signal({ id: "s-good", accuracy_pass: true });
    const { keptSignals, droppedSignals, filteringReasoning } = filterSignals(
      [bad, good],
      CONFIG,
    );
    expect(keptSignals.map((s) => s.id)).toEqual(["s-good"]);
    expect(droppedSignals).toHaveLength(1);
    expect(droppedSignals[0].signal.id).toBe("s-bad");
    expect(droppedSignals[0].reason).toBe("failed accuracy check");
    expect(filteringReasoning).toContain("failed accuracy check");
  });

  it("keeps accuracy-failed signals when enforcement is off", () => {
    const cfg = { ...CONFIG, accuracy_pass_enforced: false };
    const bad = signal({ id: "s-bad", accuracy_pass: false });
    const { keptSignals } = filterSignals([bad], cfg);
    expect(keptSignals).toHaveLength(1);
    expect(keptSignals[0].id).toBe("s-bad");
  });
});

describe("filterSignals — fuzz gate", () => {
  it("drops signals below the fuzz cutoff even if accuracy passed", () => {
    const low = signal({ id: "s-low", ref_fuzzy_distance: 50 });
    const at = signal({ id: "s-at", ref_fuzzy_distance: 80 });
    const above = signal({ id: "s-hi", ref_fuzzy_distance: 90 });
    const { keptSignals, droppedSignals } = filterSignals(
      [low, at, above],
      CONFIG,
    );
    expect(keptSignals.map((s) => s.id).sort()).toEqual(["s-at", "s-hi"]);
    expect(droppedSignals).toHaveLength(1);
    expect(droppedSignals[0].signal.id).toBe("s-low");
    expect(droppedSignals[0].reason).toContain("below cutoff=80");
  });

  it("respects a custom cutoff", () => {
    const cfg = { ...CONFIG, ref_fuzzy_distance_cutoff: 95 };
    const at = signal({ id: "s-at", ref_fuzzy_distance: 94 });
    const above = signal({ id: "s-hi", ref_fuzzy_distance: 95 });
    const { keptSignals } = filterSignals([at, above], cfg);
    expect(keptSignals.map((s) => s.id)).toEqual(["s-hi"]);
  });
});

describe("filterSignals — confidence gate", () => {
  it("drops signals below the confidence cutoff even if fuzz and accuracy passed", () => {
    const low = signal({ id: "s-low", confidence: 0.4 });
    const at = signal({ id: "s-at", confidence: 0.5 });
    const above = signal({ id: "s-hi", confidence: 0.9 });
    const { keptSignals, droppedSignals } = filterSignals(
      [low, at, above],
      CONFIG,
    );
    expect(keptSignals.map((s) => s.id).sort()).toEqual(["s-at", "s-hi"]);
    expect(droppedSignals).toHaveLength(1);
    expect(droppedSignals[0].signal.id).toBe("s-low");
    expect(droppedSignals[0].reason).toContain("confidence");
    expect(droppedSignals[0].reason).toContain("below cutoff");
  });

  it("respects a custom confidence cutoff", () => {
    const cfg = { ...CONFIG, confidence_cutoff: 0.8 };
    const at = signal({ id: "s-at", confidence: 0.79 });
    const above = signal({ id: "s-hi", confidence: 0.9 });
    const { keptSignals } = filterSignals([at, above], cfg);
    expect(keptSignals.map((s) => s.id)).toEqual(["s-hi"]);
  });
});

describe("filterSignals — no-signal pass-through", () => {
  it("keeps no-signal entries regardless of thresholds", () => {
    const ns = noSignal("doc-x");
    const good = signal({ id: "s1" });
    const bad = signal({ id: "s2", accuracy_pass: false });
    const { keptSignals } = filterSignals([ns, good, bad], CONFIG);
    // Both the no-signal and the passing signal survive; the failing
    // signal is dropped.
    expect(keptSignals.map((s) => s.id).sort()).toEqual(["nosig-doc-x", "s1"]);
  });
});

describe("filterSignals — reason ordering & accumulation", () => {
  it("accumulates each drop reason into the human-readable summary", () => {
    const acc = signal({ id: "s-acc", accuracy_pass: false });
    const fuzz = signal({ id: "s-fuzz", ref_fuzzy_distance: 40 });
    const { filteringReasoning, droppedSignals } = filterSignals(
      [acc, fuzz],
      CONFIG,
    );
    expect(droppedSignals).toHaveLength(2);
    expect(filteringReasoning).toContain("s-acc");
    expect(filteringReasoning).toContain("s-fuzz");
    expect(filteringReasoning).toContain("Filtered out 2 signal(s)");
  });

  it("accuracy check fires before the fuzz check", () => {
    // A signal that fails BOTH gates should be reported with the
    // accuracy reason, since that's checked first — this is the
    // documented behavior of the filter.
    const bothBad = signal({
      id: "s-both",
      accuracy_pass: false,
      ref_fuzzy_distance: 30,
    });
    const { droppedSignals } = filterSignals([bothBad], CONFIG);
    expect(droppedSignals).toHaveLength(1);
    expect(droppedSignals[0].reason).toBe("failed accuracy check");
  });
});

describe("filterSignals — empty input", () => {
  it("returns empty arrays and the 'no signals filtered' message", () => {
    const result = filterSignals([], CONFIG);
    expect(result.keptSignals).toEqual([]);
    expect(result.droppedSignals).toEqual([]);
    expect(result.filteringReasoning).toBe("No signals were filtered out.");
  });
});
