# Aletheia

A verifiable knowledge-base explorer. **Every claim in every answer traces back to a specific quote in a specific document**, with fuzzy-match verification that the quote is real.

Aletheia optimises for **verifiability** first — precision and recall are secondary. If you can't drill down from an answer to the source that grounds it, the answer isn't useful.

Created and open-sourced by **Nima Edelkhani** · 2026.

---

## Quickstart

**One-liner (macOS / Linux / WSL2):**

```bash
curl -fsSL https://raw.githubusercontent.com/Nima-Edelkhani/agent-aletheia/main/scripts/install.sh | bash
```

That checks Node 20+, enables pnpm via corepack, clones the repo, installs deps, and drops you into the setup wizard when your terminal is interactive.

**Manual (any platform):**

```bash
git clone https://github.com/Nima-Edelkhani/agent-aletheia.git
cd aletheia
pnpm install && pnpm setup
```

`pnpm setup` will:

1. Copy `.env.example` → `.env` (won't overwrite an existing one).
2. Seed `knowledge-base/` with the sample **Voxly** meeting-transcript corpus so you can ask questions immediately.
3. Ask you to add your Anthropic API key to `.env` yourself — the wizard never accepts the key via prompt, it stays in `.env` only.
4. Verify the key with a 1-token test call.
5. Offer to launch the web UI.

The `.env` line format is exactly:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Get a key at https://console.anthropic.com/settings/keys.

Once setup is done:

```bash
# CLI
pnpm aletheia ask "What did customers discuss in the past month?"

# Web UI
pnpm dev
# open http://localhost:3000
```

**Prereqs**: Node 20+, pnpm 9+ (installed automatically by the one-liner via corepack), an Anthropic API key. That's the entire dependency footprint.

---

## What Aletheia does

You have a folder of JSON documents (meeting transcripts, notes, memos, anything). You ask a question in plain English. Aletheia:

1. **Filters** the KB by metadata only (never reads bodies at this step) to find a narrow doc scope.
2. **Rescopes** the multi-doc question into a per-doc question.
3. **Fans out one sub-agent per doc** in parallel. Each sub-agent reads only its own doc and emits zero or more affirmative findings.
4. **Filters signals** by fuzz-score and accuracy thresholds.
5. **Aggregates** into a plain-English answer with **inline `[s1]/[s2]` citation chips** that jump to the signal cards.

Two-layer architecture:

- **Orchestrator** (`src/core/orchestrator.ts`) — the 5-step loop above.
- **Per-doc sub-agent** (`src/core/subagent.ts`) — single Claude Agent SDK `query()` per doc with a custom in-process MCP tool that forces structured output. Affirmative-only contract: emits a signal only when the doc positively answers the rescoped question. Emits `no_signal` otherwise. Never emits a negative-payload "signal".

See [`PRD.md`](./PRD.md) for the original spec and [`execution_plan.md`](./execution_plan.md) for the build plan.

---

## Signal shape

Every signal that survives filtering carries:

| Field                     | Notes                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| `reference_text`          | Verbatim quote from the source body                                |
| `before_reference_text`   | ~1–2 paragraphs before, cut deterministically from real body       |
| `after_reference_text`    | ~1–2 paragraphs after, cut deterministically from real body        |
| `finding_summary`         | One-sentence positive finding in the sub-agent's own words         |
| `finding_category`        | Snake_case label the sub-agent invents (open-string, no fixed enum)|
| `ref_fuzzy_distance`      | 0–100 partial-ratio fuzz match of the quote vs body                |
| `confidence`              | 0.0–1.0 sub-agent self-report                                      |
| `accuracy_pass`           | `true` only if the LLM judge passed all three checks (see below)   |
| `accuracy_adjudication`   | The judge's full verdict — three checks + reasons + cost + model   |
| `cost_estimate`           | USD (sub-agent turn + judge call), from SDK usage tokens           |
| `model`                   | Sub-agent model that emitted this signal                           |
| `payload_format`          | `null` by default; populated when `--extract` was used             |
| `payload`                 | `{}` by default; populated when `--extract` was used               |

`no-signal` entries retain `scope_of_signal`, `question_rescoped`, `payload_format`, `id`, and `model` so a caller can still see which docs the orchestrator examined and got nothing from.

## The accuracy judge

Every signal goes through a **3-check LLM judge** before it can pass. The judge uses the cheap `accuracy_judge` model (default: `claude-haiku-4-5-20251001`) and returns a `{ pass, reason }` verdict for each of these three questions:

1. **`reference_supports_summary`** — Does the `finding_summary` follow strictly from the `reference_text` plus its surrounding context (`before_reference_text` / `after_reference_text`)? Rejects paraphrase drift, unstated inferences, invented figures.
2. **`summary_addresses_question`** — Does the `finding_summary` directly address the `rescoped_question`? Rejects on-doc findings that are off-topic for the question actually asked.
3. **`category_is_sensible`** — Is the `finding_category` a specific, well-formed snake_case label that describes THIS finding? Rejects generic dumps like `misc` / `stuff` / `other` and labels that don't match the summary.

A signal's `accuracy_pass` is `true` only when **all three** checks pass. The full verdict — each `{ pass, reason }` plus the judge's cost and model — is preserved on the signal as `accuracy_adjudication` so you can drill down in the UI card or in the trace when a signal fails.

Signals that fail the cheap pre-filter (payload doesn't validate against a `specified_finding_format` schema, or fuzz below `ref_fuzzy_distance_cutoff`) short-circuit to a fail without spending on the judge. The pre-filter reason is written into `accuracy_adjudication.reference_supports_summary.reason`.

The judge sees four few-shot examples in its system prompt: an all-pass case, a reference-drift failure, an off-topic failure, and a sloppy-category failure. Prompts are prompt-cached across sub-agents in a single question run.

---

## CLI reference

```bash
pnpm aletheia ask <question> [flags]
```

| Flag                        | Effect                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `--extract <schemaOrPath>`  | Typed extraction schema (inline JSON if starts with `{`, else file path).             |
| `--scope`                   | Print every doc ID in `scope_of_exploration` (default just shows the count).          |
| `--expand`                  | Render each signal as a full card (rescoped question, confidence, accuracy, stats).   |
| `--out <path>`              | Write the full response + trace JSON to disk.                                          |
| `--trace`                   | Print the orchestrator trace at the end.                                              |
| `--debug`                   | Print the entire `AletheiaResponse` + trace as JSON to stdout alongside the summary.  |

Other subcommands:

- `pnpm aletheia list-docs` — print the metadata index for every doc in the KB.
- `pnpm aletheia evals` — run the golden-set evaluation harness.

Timestamped one-line progress fires on stderr as the orchestrator moves through each step and each sub-agent.

---

## Typed extraction (`--extract`)

For questions where you want structured data alongside the finding, pass a JSON Schema:

```bash
# Inline JSON
pnpm aletheia ask "Which meetings mentioned a specific dollar figure?" \
  --extract '{"type":"object","additionalProperties":false,
              "required":["amount_usd","context"],
              "properties":{
                "amount_usd":{"type":"number"},
                "context":{"type":"string"}}}'

# Or from a file
pnpm aletheia ask "..." --extract ./schemas/deal-facts.json
```

Every emitted signal will then also fill a `payload` conforming to that schema; signals whose payloads don't validate against it are dropped by the accuracy filter. In the web UI, the same feature lives under the **Advanced** toggle on the question form.

---

## Web UI

`pnpm dev` starts Next.js at `http://localhost:3000`. Brutal editorial theme (Hallmark redesign) with light/dark toggle top-right.

- **Question form** — plain textarea + Advanced toggle for a typed extraction schema.
- **Live progress log** — streams from `POST /api/ask` (NDJSON) with a timestamp per orchestrator event.
- **Answer** rendered as Markdown with inline `[s1] [s2] ...` clickable citation chips. Clicking a chip smooth-scrolls to the corresponding Signal card and highlights it with an acid-yellow slab shadow.
- **Signal cards** — always-visible sections: rescoped question, quote (before-grey / reference-black-bold / after-grey with fuzz meter), finding summary + open-string category, optional typed extraction block when `--extract` was used, stats, and a collapsible full-body reader.
- **Performance panel** — cost / elapsed / signal count + trace JSON viewer.

---

## Adding your own documents

Drop documents into `knowledge-base/`. Aletheia auto-detects **four formats**:

| Format  | How the `id` is derived                                | How `metadata` is derived                                                                     | How `body` is derived                            |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `.json` | `id` field inside the JSON                             | `metadata` field inside the JSON                                                              | `body` field inside the JSON                     |
| `.md`   | filename **with extension** (e.g. `notes.md`)          | YAML frontmatter between `---` fences at the top, plus `type: "markdown"`. Empty if none.     | Everything after the frontmatter (or whole file) |
| `.txt`  | filename **with extension** (e.g. `memo.txt`)          | `{ "type": "text" }`                                                                          | Entire file contents                             |
| `.xml`  | filename **with extension** (e.g. `report.xml`)        | `<metadata>` child element if present. Else: root element's attributes. Plus `type: "xml"`.   | `<body>` child element if present, else all inner text |

### Canonical shapes

**JSON**
```json
{
  "id": "your-doc-id",
  "metadata": { "customer": "Acme", "date": "2026-05-01" },
  "body": "the full text of the document..."
}
```

**Markdown** — YAML frontmatter is optional
```markdown
---
customer: Meridian
date: 2026-06-12
tier: enterprise
priorities: ["pricing", "integration"]
---

Meeting transcript body here...
```

**Text** — no shape, no metadata beyond `{ type: "text" }`. Simplest possible input.

**XML** — canonical shape or arbitrary
```xml
<!-- Canonical -->
<document>
  <metadata>
    <customer>Anchorline</customer>
    <date>2026-06-01</date>
  </metadata>
  <body>Full transcript here...</body>
</document>

<!-- Auto-derive (root attributes → metadata, inner text → body) -->
<transcript customer="Globex" date="2026-04-04">
  <turn speaker="Sarah">Welcome.</turn>
  <turn speaker="John">Let's talk pricing.</turn>
</transcript>
```

### Rules and guarantees

- **No files are written to disk.** Source files stay the single source of truth. All parsing happens in memory.
- **The orchestrator's filter step only reads `metadata`** — bodies never enter its LLM context.
- **Each sub-agent loads only its own doc's metadata and body** (never any other doc's).
- **IDs never collide across formats** — non-JSON docs include their file extension in the `id`, so `notes.md` and `notes.txt` are distinct docs.
- **Unsupported extensions and malformed files are surfaced, not swallowed** — they show up in the KB panel as "N skipped" with a reason, and each skip is logged to stderr.
- **The body-leak invariant is unit-tested** across all four formats.

### Resetting to the sample data

```bash
rm knowledge-base/*.json && pnpm setup   # restores the 10 Voxly transcripts
```

---

## Evaluation

The repo ships with a **synthetic corpus of 10 Voxly meeting transcripts** (`examples/voxly-corpus/`), a **golden set of 15 hand-labeled questions** (`evals/golden-set.json`), and **few-shot exemplars** (`evals/few-shots/`) that show what a well-formed run looks like end-to-end.

```bash
pnpm evals:smoke               # 3-question smoke test — ~3–5 min
pnpm evals                     # full 15-question golden set — ~15 min
pnpm evals -- --question q-004 # single question by ID
pnpm evals -- --report-md      # also write a Markdown report
pnpm evals -- --help           # all threshold override flags
```

The harness measures **four distinct qualities** and gates on suite-wide aggregates for each. Per-question values appear in the report for drill-down but never gate pass/fail on their own.

| Layer | What it tests | Metrics | Default gate |
| --- | --- | :---: | :---: |
| **Filter step** | Did the filter pick the right docs? | `mean_recall` (`mean_precision` tracked but not gated) | ≥ 0.9 |
| **Verifiability** | Are the quotes real? | `mean_verifiability_fuzz` / `..._substring_hit_rate` | ≥ 85 / ≥ 0.85 |
| **Sub-agent quality** | Are raw sub-agent emissions clean? (weighted across all raw signals in the run) | `mean_raw_judge_reference_pass_rate` / `..._question_` / `..._category_` / `..._overall_` | ≥ 0.85 / ≥ 0.85 / ≥ 0.80 / ≥ 0.70 |
| **Answer coverage** | Did each expected meeting contribute signals? | `mean_signal_count_by_meeting_recall` | ≥ 0.9 |

**Golden-set schema** — each question carries `expected_scope_ids`, `expected_answer_must_mention`, and `expected_signals_by_meeting` (map of doc_id → minimum signal count that must appear in `response.signals`). This last field is the tightest bar because it verifies each expected meeting actually contributed signals to the final answer, catching pipeline breaks that keyword-only checks miss.

**Why judge rates are measured on `trace.raw_signals`** — measuring judge pass rates on `response.signals` would show 100% always (everything there passed by construction). The interesting question is "how often does the sub-agent emit a finding the judge accepts?" — that requires looking at raw emissions before the filter dropped anything.

**Why precision is tracked but not gated** — the filter prompt is intentionally inclusive ("when unsure, INCLUDE"). Gating precision at 0.9 would fight the design. It still appears in every report; if it drifts toward 0.3 that's a sign the filter is over-scoping and worth investigating.

Reports are written to `evals/report/<timestamp>.json` (always) and `<timestamp>.md` (with `--report-md`). See [`evals/README.md`](./evals/README.md) for full metric definitions, threshold overrides, and the `expected_signals` schema.

---

## Testing

```bash
pnpm test           # vitest — 75 tests across 7 files
pnpm typecheck      # tsc --noEmit
pnpm ci             # typecheck + tests (what CI runs)
```

Coverage:

- **`tests/scoring.test.ts`** (16 tests) — fuzzball edge cases, before/after context extraction, `preFilterAccuracy` gate (schema + fuzz), null-schema pass-through, custom cutoffs.
- **`tests/knowledge-base.test.ts`** (22 tests) — the body-leak invariant on `listMetadata()`; all four supported formats (JSON, Markdown with YAML frontmatter, plain text, XML canonical + auto-derive); collision-free IDs across formats; `listMetadataReport()` skipped-file surfacing.
- **`tests/cost.test.ts`** (6 tests) — token → USD conversion, cache read/write, unknown-model fallback.
- **`tests/mcp-emit-signals.test.ts`** (7 tests) — MCP tool Zod schema and closure-capture contract with and without `specifiedFindingFormat`, direct handler invocation.
- **`tests/citations.test.ts`** (11 tests) — the `[sN]` → markdown-link preprocessor and cited-index extractor, including case-sensitivity and multi-digit handling.
- **`tests/signal-filter.test.ts`** (9 tests) — step 6 threshold filter: `accuracy_pass_enforced` on/off, `ref_fuzzy_distance_cutoff` variants, `no-signal` pass-through, drop-reason accumulation, ordering guarantees, empty-input case.
- **`tests/accuracy-adjudication.test.ts`** (4 tests) — structural contract for the LLM judge's verdict: three named checks with `{ pass, reason }`, `overall_pass` mirrors the AND, cost/model preserved, reasons always populated.

---

## Configuration

Runtime knobs live in [`config/thresholds.json`](./config/thresholds.json):

| Key                              | Purpose                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `accuracy_pass_enforced`         | If true, drop signals whose 3-check judge verdict overall_pass=false.               |
| `ref_fuzzy_distance_cutoff`      | Pre-filter fuzz threshold (0–100). Signals below this are dropped from the answer AND fail without calling the judge. Default 80. |
| `confidence_cutoff`              | Minimum sub-agent self-reported confidence (0.0–1.0). Signals below this are dropped from the answer. Default 0.5. |
| `timeouts_ms`                    | `soft_timeout_ms` + `soft_at_percent_done` + `hard_timeout_ms` for the fan-out.     |
| `models`                         | Per-role model IDs: `filter`, `rescope`, `subagent`, `accuracy_judge`, `aggregate`. |
| `context_window`                 | `before_max_chars` / `after_max_chars` — how much context to cut around a quote.    |

Price table for cost estimation lives in code (`src/core/cost.ts:PRICES`) — update as pricing changes.

---

## Layout

```
src/
├── core/
│   ├── orchestrator.ts       Filter → rescope → fan-out → filter signals → aggregate
│   ├── subagent.ts           Per-doc SDK query, affirmative-only contract, post-processing
│   ├── knowledge-base.ts     listMetadata (never leaks body) + loadDoc
│   ├── scoring.ts            Fuzzball + before/after extraction + heuristic accuracy
│   ├── mcp/emit-signals.ts   In-process MCP server with conditional Zod shape
│   ├── llm.ts                Anthropic wrapper for orchestrator LLM steps
│   ├── cost.ts               Token → USD price table
│   ├── config.ts             Loader for config/thresholds.json
│   └── types.ts              Signal / Response data model + ProgressEvent + AskOptions
├── app/                      Next.js 15 App Router — brutal theme
│   ├── page.tsx, layout.tsx, globals.css, icon.svg
│   ├── actions.ts            Server actions
│   ├── api/ask/route.ts      Streaming POST /api/ask (NDJSON progress + result)
│   └── components/           QuestionForm, ProgressLog, ResponseView, SignalCard
├── components/               Shared UI (mode-toggle, aletheia-mark, section-marker) + shadcn/ui + AI Elements
└── bin/aletheia.ts           CLI: ask · list-docs · evals

evals/                        golden-set.json + few-shots/ + run-evals.ts + report/
examples/voxly-corpus/        Synthetic test corpus (10 meeting transcripts)
config/thresholds.json        Runtime knobs
knowledge-base/               Your docs go here (seeded by `pnpm setup`)
tests/                        Vitest regression tests
scripts/setup.mjs             `pnpm setup` bootstrap
```

---

## Tech stack

- **TypeScript 5** on Node 20+, pnpm.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) for sub-agent orchestration; **Anthropic SDK** for the orchestrator's LLM calls.
- **Zod** for MCP tool input shapes; **Ajv** for JSON Schema validation of extracted payloads.
- **fastest-levenshtein** for fuzzball's partial-ratio window scan.
- **Next.js 15 App Router** for the web UI, with Server Actions and a streaming NDJSON route.
- **react-markdown** + **remark-gfm** for rendering the answer.
- **shadcn/ui** + **Vercel AI Elements** (Task, Reasoning) + **Tailwind CSS**.
- **vitest** for tests.

---

## Philosophy

- **Verifiability first.** `reference_text` is verbatim; before/after context is cut from the real body, never trusted from the model. Sub-agents can't see other docs' bodies (single-doc constraint) and can't see filesystem tools (`settingSources: []`).
- **No boolean gate fields on signals.** A doc with nothing to say emits `no_signal`, not a "signal" with `raised_X: false`. This makes signal counts semantically meaningful.
- **No orchestrator enums.** `finding_category` is an open string the sub-agent chooses after reading the body — the orchestrator hasn't read the docs and shouldn't be constraining categories a priori.
- **Metadata is per-doc-only for the sub-agent.** The sub-agent sees ITS doc's metadata block so it can source facts like `meeting_date` verbatim without hallucinating them. But it never sees another doc's metadata or body — the isolation guarantee is preserved.
- **The answer text always cites.** Every factual claim in the aggregated answer carries an inline `[sN]` marker that renders as a clickable chip in the UI (or a literal token in the CLI). No claims without provenance.
- **Accuracy is judged, not assumed.** Every signal is adjudicated by a 3-check LLM judge (reference-supports-summary, summary-addresses-question, category-is-sensible) before it can pass. All three must clear for `accuracy_pass = true`. The judge's per-check `{ pass, reason }` verdicts are preserved on the signal, drillable in the UI card and inspectable in the trace.

---

## Safety & privacy

- **Your API key never leaves your machine** except in the outbound HTTPS call to `api.anthropic.com`. `.env` is gitignored — you cannot accidentally commit it with `git add .`.
- **No telemetry, no analytics, no crash reporting**. Aletheia is a local-first tool.
- **The only external network calls** are to `api.anthropic.com` (LLM) and to Google Fonts on the web UI (via `next/font/google`).
- **Nothing about your questions or answers is persisted** beyond `evals/report/*` (gitignored) and any file you explicitly write with `pnpm aletheia ask ... --out`.
- **Untrusted docs are treated as data** — sub-agents run with `settingSources: []` (no filesystem tools) and a prompt-injection-resistant system prompt. See [`SECURITY.md`](./SECURITY.md) for the full threat model.

If you find something that looks like a vulnerability, please open a private security advisory via GitHub — see [`SECURITY.md`](./SECURITY.md).

## Contributing

PRs welcome. Please:

1. Run `pnpm ci` before opening a PR.
2. If you change the signal data model, update the corresponding fields in `PRD.md` and `README.md` (this file's Signal shape table).
3. If you add a new orchestrator step or `ProgressEvent`, extend the corresponding test file (or add a sibling one) with a fixture for the new event.

Full guidance in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
