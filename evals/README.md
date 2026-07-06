# Aletheia · Evals

This directory holds the evaluation harness, the golden question set, few-shot exemplar traces, and the report output.

## Files

```
evals/
├── golden-set.json     15 labeled questions with expected scope/signals/answer patterns
├── run-evals.ts        Harness — computes precision/recall/verifiability/latency/cost
├── few-shots/          Hand-labeled exemplar traces for the model to read
│   ├── q-001-pricing-concerns.json
│   ├── q-006-tier-filter.json
│   └── q-013-typed-extraction.json
├── report/             Timestamped JSON (+ optional Markdown) reports
└── README.md           This file
```

## Running

```bash
pnpm evals:smoke                     # 3-question smoke test — ~2 minutes
pnpm evals                           # full 15-question golden set — ~10 minutes
pnpm evals -- --question q-001       # run a single question by ID
pnpm evals -- --report-md            # also write a Markdown report
pnpm evals -- --min-recall 0.8       # override the recall threshold
pnpm evals -- --help                 # all flags
```

**Exit codes**:

- `0` — all thresholds passed
- `1` — one or more thresholds failed (regression)
- `2` — runtime error (KB missing, API key missing, golden set malformed)

`--question` mode always exits 0; single-question runs are for iteration, not gating.

## Thresholds

Default pass/fail thresholds live in `run-evals.ts`:

| Metric                                       | Default |
| -------------------------------------------- | ------: |
| `mean_precision`                             |     0.5 |
| `mean_recall`                                |     0.7 |
| `mean_verifiability_fuzz`                    |      85 |
| `mean_verifiability_substring_hit_rate`      |    0.85 |

Override any of them with `--min-precision`, `--min-recall`, `--min-fuzz`, `--min-substring`. The threshold set used for a given run is echoed into the JSON report so you can reproduce results.

## Metrics

For each question the harness reports:

- **Precision** — fraction of returned `scope_of_exploration` that appears in `expected_scope_ids`.
- **Recall** — fraction of `expected_scope_ids` covered by the returned scope.
- **Signal count** vs. `expected_signal_count_min`.
- **Verifiability (fuzz)** — mean `ref_fuzzy_distance` across signals returned by the run.
- **Verifiability (substring)** — % of signals whose `reference_text` genuinely appears as a substring in the referenced doc's body. This is the "did we make up the quote?" hard check.
- **Answer coverage** — presence check against `expected_answer_must_mention` and `expected_answer_must_not_mention`.
- **Latency (ms)** and **cost (USD)**.

Aggregates are the arithmetic mean across per-question values (except cost, which sums).

## Few-shot exemplars

`few-shots/` holds hand-labeled traces showing what a well-formed run looks like for representative questions. Each file explains:

- What the orchestrator SHOULD do at each step (filter, rescope, fan-out, aggregate).
- What good signals look like — `finding_summary` phrasing, `finding_category` naming, `reference_text` shape, confidence range.
- What a good `response_text` reads like, with `[sN]` citations.
- The **anti-patterns** the run must avoid (invented figures, boolean gate fields, non-cited claims, etc.).

Use these as reference material when:

- The eval scores regress and you need to eyeball what's now different.
- You're onboarding to the codebase and want to see the pipeline end-to-end.
- You're extending the orchestrator prompts — mentally check that the new prompt still produces something like the exemplar.

The exemplars are **not** currently injected into the orchestrator prompts. They're documentation. If you want to few-shot the aggregate step, you can read them into `orchestrator.ts:aggregateStep` and append to the system prompt — but consider whether that's worth the token cost first.

## Reports

Every run writes `evals/report/<iso-timestamp>.json`. With `--report-md`, it also writes `.md` alongside. Both files are ignored by git — treat them as run artifacts, not source of truth.

The JSON report includes:

- `mode` — `smoke` / `full` / `single`
- `aggregates` — mean metrics across the run
- `thresholds` — the pass/fail bar used for THIS run
- `passed` / `failures[]` — which thresholds failed
- `per_question[]` — full per-question breakdown including the full `response_text`

## When scores drop

1. **Eyeball the failing question** in the JSON report — `response_text` is included in full.
2. **Compare against the closest few-shot exemplar** — is the shape different? Are `[sN]` markers missing? Are there boolean-gate signals?
3. **Check the orchestrator trace** — run the same question via `pnpm aletheia ask "..." --debug` to see the full step-by-step. `dropped_signals` in the trace is often the smoking gun.
4. **Check for prompt drift** — the aggregator and rescope step prompts in `src/core/orchestrator.ts` and the sub-agent prompt in `src/core/subagent.ts` are the levers.
