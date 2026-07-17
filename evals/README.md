# Aletheia · Evals

The evaluation harness answers four questions about any Aletheia code change:

1. **Did the filter step pick the right documents?** (recall on `scope_of_exploration`)
2. **Are the surviving signals real and verifiable?** (fuzz score of `reference_text` against the source body)
3. **Are the sub-agents emitting quality findings?** (3-check judge pass rates on raw sub-agent output)
4. **Did each expected meeting actually contribute signals to the final answer?** (signal count by meeting)

## Files

```
evals/
├── golden-set.json     10 labeled questions with expected scope/answer patterns
├── run-evals.ts        Harness — computes all metrics + writes reports
├── few-shots/          Hand-labeled exemplar traces for reference material
├── report/             Timestamped JSON (+ optional Markdown) reports
└── README.md           This file
```

## Running

```bash
pnpm evals:smoke                        # 3-question smoke test — ~3–5 min
pnpm evals                              # full 10-question set — ~10 min
pnpm evals -- --question q-001          # single question by ID
pnpm evals -- --report-md               # also write a Markdown report
pnpm evals -- --min-recall 0.85         # override any threshold
pnpm evals -- --help                    # all flags
```

**Exit codes**:

- `0` — all thresholds passed
- `1` — one or more thresholds failed (regression)
- `2` — runtime error (KB missing, API key missing, golden set malformed)

`--question` mode always exits 0; single-question runs are for iteration, not gating.

## Golden-set schema

Each question in `golden-set.json`:

```jsonc
{
  "id": "q-004",
  "question": "Which customers are hitting integration blockers, and what integrations are involved?",
  "expected_scope_ids": [
    "mtg-2026-02-09-beacon_saas-technical_review",
    "mtg-2025-08-14-fintrust-discovery_call"
  ],
  "expected_answer_must_mention": ["Beacon SaaS", "Zendesk", "Twilio"],
  "expected_signals_by_meeting": {
    "mtg-2026-02-09-beacon_saas-technical_review": 2,
    "mtg-2025-08-14-fintrust-discovery_call": 1
  }
}
```

- **`expected_scope_ids`** — docs the metadata-only filter step should return. The filter step filters strictly on `date` plus structured metadata fields (`customer`, `tier`, `meeting_type`, `product_discussed`, `participants`) — it never infers topical relevance. Measured as recall. Precision is tracked but not gated (the filter prompt is intentionally inclusive on structured filters).
- **`expected_answer_must_mention`** — substrings that must appear in `response_text` (case-insensitive). Keyword proxy for "the answer surfaces the right customers/topics".
- **`expected_signals_by_meeting`** *(optional)* — for each meeting listed, the minimum number of signals with that `scope_of_signal` that must appear in `response.signals`. Catches "the scope was right but the fan-out returned nothing from one of the expected docs" — a failure mode `must_mention` alone can't catch.

**Removed** from the old schema: `expected_signal_count_min` (subsumed by `expected_signals_by_meeting`), `expected_answer_must_not_mention` (rejected as low-signal — the aggregate step only receives in-scope signals, so out-of-scope customers wouldn't be mentioned unless something is severely broken).

## Thresholds

All thresholds are **suite-wide aggregates**. Per-question values appear in the report for drill-down but never gate pass/fail — one 5-signal question can't reliably tell you "the judge is passing 80% of the time" but 40 signals across 15 questions can.

| Metric | Default | CLI override |
| --- | ---: | --- |
| `mean_recall` | 0.9 | `--min-recall` |
| `mean_verifiability_fuzz` | 85 | `--min-fuzz` |
| `mean_raw_judge_reference_pass_rate` | 0.85 | `--min-raw-ref` |
| `mean_raw_judge_question_pass_rate` | 0.85 | `--min-raw-q` |
| `mean_raw_judge_category_pass_rate` | 0.80 | `--min-raw-cat` |
| `mean_raw_judge_overall_pass_rate` | 0.70 | `--min-raw-overall` |
| `mean_signal_count_by_meeting_recall` | 0.90 | `--min-meeting-recall` |

The threshold set actually used is echoed into the JSON report so you can reproduce results.

**Precision is tracked but not gated.** Precision measures "did the filter include docs it shouldn't have?" — but the filter prompt is intentionally inclusive ("when unsure, INCLUDE the document"). Gating precision at 0.9 would fight the design. It still appears in every report; if you notice it drifting toward 0.3 that's a sign the filter is over-scoping and worth investigating.

## What each metric measures

### Filter step
- **`mean_recall`** — of the docs the golden set says should be in scope, what fraction did the filter include? Regressions here mean the filter LLM is either misreading a date-window expression or misapplying a structured filter (customer/tier/meeting_type/product_discussed).
- `mean_precision` — of the docs the filter DID include, what fraction were correct? Not gated but visible.

### Verifiability (on `response.signals` — the filtered set)
- **`mean_verifiability_fuzz`** — mean `ref_fuzzy_distance` across surviving signals. Sub-80 signals never make it here (dropped by the accuracy filter), so this is measured across [80, 100]: a score of 100 means the reference is a verbatim substring of the body, 80–99 means a close (edit-distance) match. Regressions here mean sub-agents are drifting toward paraphrase.

### Sub-agent quality (on `trace.raw_signals` — pre-filter)

These tell you whether the sub-agent is emitting good findings BEFORE the accuracy filter drops the failing ones. **Measuring on the filtered set would show 100% pass rates always** (everything there passed by construction).

Weighted across all raw signals from all questions:

- **`mean_raw_judge_reference_pass_rate`** — fraction where the judge confirmed the `finding_summary` follows from the `reference_text` + surrounding context. Regressions mean the sub-agent is paraphrasing or inventing.
- **`mean_raw_judge_question_pass_rate`** — fraction where the judge confirmed the `finding_summary` addresses the rescoped question. Regressions mean the sub-agent is emitting on-doc-but-off-topic findings.
- **`mean_raw_judge_category_pass_rate`** — fraction where the judge confirmed the `finding_category` is specific and well-named. Regressions mean the sub-agent is using lazy generic labels (`misc`, `stuff`, `general`).
- **`mean_raw_judge_overall_pass_rate`** — all three checks passing.

### Answer coverage (on `response.signals`)

- **`mean_signal_count_by_meeting_recall`** — for each expected meeting, does `response.signals` contain at least the required count from that meeting? Score = matched_meetings / total_expected_meetings for each question, then averaged across questions.

This is the tightest bar. It answers **"did the right meeting actually contribute signals to the final answer?"** — the interaction between filter, fan-out, judge, and threshold filter. If the pipeline includes the doc in scope, the sub-agent fires, the judge accepts the signal, and the threshold filter lets it through — this metric passes. If any of those four steps fails, this metric drops.

## Few-shot exemplars

`few-shots/` holds hand-labeled traces showing what a well-formed run looks like. Reference material; not injected into prompts.

## When scores drop

1. **Eyeball the failing question** in the JSON report — `response_text` is included in full.
2. **Look at the meeting-coverage detail** in the Markdown report — which specific expected meeting failed to contribute?
3. **Compare against the closest few-shot exemplar** — is the shape different? Are `[sN]` markers missing?
4. **Run the same question via `pnpm aletheia ask "..." --debug`** to see the full step-by-step. `dropped_signals` is often the smoking gun; per-question `raw_judge_*_pass_rate` tells you which check is failing.
5. **Check for prompt drift** — the aggregator and rescope prompts in `src/core/orchestrator.ts`, the sub-agent prompt in `src/core/subagent.ts`, and the judge prompt in `src/core/subagent.ts:JUDGE_SYSTEM_PROMPT` are the levers.
