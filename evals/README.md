# Aletheia · Evals

The evaluation harness answers four questions about any Aletheia code change:

1. **Did the filter step pick the right documents?** (recall on `scope_of_exploration`)
2. **Are the surviving signals real and verifiable?** (fuzz score + substring-in-body check)
3. **Are the sub-agents emitting quality findings?** (3-check judge pass rates on raw sub-agent output)
4. **Did each expected meeting actually contribute signals to the final answer?** (signal count by meeting)

## Files

```
evals/
├── golden-set.json     Labeled questions with expected scope/answer patterns
├── run-evals.ts        Harness — computes all metrics + writes reports
├── report/             Timestamped JSON (+ optional Markdown) reports
└── README.md           This file
```

The accuracy-judge few-shot examples live in `config/judge-fewshots.json`
(loaded at runtime by `src/core/judge-fewshots.ts`), not under `evals/` — the
judge runs inside every sub-agent, so its exemplars are runtime config. See
["Sub-agent quality"](#sub-agent-quality-on-tracerraw_signals--pre-filter).

## Running

```bash
pnpm evals                              # full golden set (real LLM calls)
pnpm evals -- --question q-001          # single question by ID
pnpm evals -- --report-md               # also write a Markdown report
pnpm evals -- --min-recall 0.85         # override any threshold
pnpm evals -- --help                    # all flags
```

> `pnpm evals:smoke` still exists but its `SMOKE_IDS` (`q-001`, `q-006`, `q-009`)
> predate the current golden set — only `q-001` matches today, so it runs a
> single question. Refresh `SMOKE_IDS` in `run-evals.ts` if you grow the set.

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
| `mean_verifiability_substring_hit_rate` | 0.85 | `--min-substring` |
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

Both metrics are averaged **only over questions that produced ≥1 signal** (see `questions_with_signals` in the report). A legitimately empty answer — e.g. "no meetings fell in that window" (q-002) or "no grounded evidence" (q-004) — has nothing to verify, so counting it as `fuzz=0` / `substring=0` would wrongly drag the suite mean down. When *no* question produces signals, these two thresholds are skipped entirely (like the raw-judge and meeting-recall gates).

- **`mean_verifiability_fuzz`** — mean `ref_fuzzy_distance` across surviving signals. Drops here mean sub-agents are paraphrasing quotes.
- **`mean_verifiability_substring_hit_rate`** — fraction of signals whose `reference_text` genuinely appears in the referenced doc's body. This is the "did we make up the quote?" hard check.

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

## Accuracy-judge few-shots

`config/judge-fewshots.json` holds the pass/fail exemplars the accuracy judge
reads on every signal. It is organized by the judge's three checks —
`reference_supports_summary`, `summary_addresses_question`,
`category_is_sensible` — and each check carries examples that ISOLATE it (the
target check's verdict is the teaching point; the other two are held as pass).
`src/core/judge-fewshots.ts` renders them into the judge system prompt at
runtime, so you can tune judge behavior by editing the JSON — no code change.

The three `raw_judge_*_pass_rate` metrics below measure exactly these checks,
so if one of them regresses, add or sharpen the corresponding check's examples.

## When scores drop

1. **Eyeball the failing question** in the JSON report — `response_text` is included in full.
2. **Look at the meeting-coverage detail** in the Markdown report — which specific expected meeting failed to contribute?
3. **Check which judge check is failing** — per-question `raw_judge_reference_pass_rate` / `raw_judge_question_pass_rate` / `raw_judge_category_pass_rate` isolates the check; sharpen that check's examples in `config/judge-fewshots.json`.
4. **Run the same question via `pnpm aletheia ask "..." --debug`** to see the full step-by-step. `dropped_signals` is often the smoking gun; per-question `raw_judge_*_pass_rate` tells you which check is failing.
5. **Check for prompt drift** — the aggregator and rescope prompts in `src/core/orchestrator.ts`, the sub-agent prompt in `src/core/subagent.ts`, and the judge prompt (`JUDGE_SYSTEM_PROMPT_BASE` + `config/judge-fewshots.json`) are the levers.
