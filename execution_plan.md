# Aletheia — Execution Plan

## Context

Greenfield build. `PRD.md` is the only file in the repo. Aletheia is a "verifiable RAG" agent: it explores a JSON knowledge-base and answers questions such that **every claim in the answer traces back to a specific quote in a specific document**, with fuzzy-match verification that the quote is real. Verifiability is the north star — precision and recall are secondary.

The system has two layers:
- **Orchestrator**: filters docs by metadata, rescopes the question per-doc, defines a strongly-typed payload schema, fans out one sub-agent per doc, aggregates signals with threshold filtering, produces a final answer.
- **Per-doc sub-agent**: loads exactly one doc body, emits either a list of `signal`s or a single `no-signal`, each with a `reference_text` quote + before/after context, fuzzball score, and confidence.

---

## Data models (verbatim from PRD.md — build to these exactly)

Source: `PRD.md` lines 24–66. Copied here so implementation cannot drift.

### Top-level Response

```
{
  "question": The question user typed,
  "response": {
     "scope_of_exploration": A list of all documents IDs that were included in the search
     "cost_estimate": The $ estimate for the token cost of generating this response
     "delay": How long it took to generate this response
     "response_text": The high-level aggregated answer to the question (human readable and directly answering their question)
     "response_reasoning": The plain english resoning for how the aggregation was done
     "filtering_reasoning": If any signal was filtered out, the reasoning behind it
     "signals": [
        {
           "signal_type: signal (either "signal" or "no-signal")
           "scope_of_signal": The ID of the knowledgebase doc that is the scope for this signal
           "question_rescoped": The user question that is rescoped (rephrased) to be about one document only
           "payload_format": The strongly typed format for the signal's payload - this varies for every question and this is the format that the orchestrator expects to get the signal reported back
           "id": ID for the signal
           "reference_text": The complete quote snippet from the doc above that contained the signal
           "before_reference_text": One or two sentences immediately before the reference_text
           "after_reference_text": One or two sentences immediately after the reference_text
           "ref_fuzzy_distance": The fuzzball (fuzzy matching) score (0-100) of how closely the reference matches a part of the source document
           "confidence": the models confidence score in this response
           "cost_estimate": cost estimate for this individual signal
           "model": model used to generate this signal
           "accuracy_pass": whether the signal passed the accuracy test
        }
     ]
}
```

### No-signal variant

```
signal for type no-signal =
{
   "signal_type: no-signal (either "signal" or "no-signal")
   "scope_of_signal": The ID of the knowledgebase doc that is the scope for this signal
   "question_rescoped": The user question that is rescoped (rephrased) to be about one document only
   "payload_format": The strongly typed format for the signal's payload - this varies for every question and this is the format that the orchestrator expects to get the signal reported back
   "id": ID for the signal
   "model": model used to generate this signal
}
```

### TypeScript translation (build target)

The zod schemas and TS types below are the enforceable form of the above. All fields, including the PRD's exact keys (`signal_type`, `scope_of_signal`, `ref_fuzzy_distance`, etc.), are preserved literally — no renaming, no camelCase drift.

```ts
// src/core/types.ts

export type PayloadFormat = Record<string, unknown>; // JSON Schema fragment, per-question

export interface SignalSignal {
  signal_type: "signal";
  scope_of_signal: string;               // doc id
  question_rescoped: string;
  payload_format: PayloadFormat;
  id: string;
  reference_text: string;                // exact quote from doc body
  before_reference_text: string;         // 1–2 sentences before, cut from body (not model)
  after_reference_text: string;          // 1–2 sentences after, cut from body (not model)
  ref_fuzzy_distance: number;            // 0–100, rapidfuzz-equivalent partial_ratio
  confidence: number;                    // model self-report, 0–1
  cost_estimate: number;                 // USD
  model: string;
  accuracy_pass: boolean;
  payload: Record<string, unknown>;      // conforms to payload_format
}

export interface SignalNoSignal {
  signal_type: "no-signal";
  scope_of_signal: string;
  question_rescoped: string;
  payload_format: PayloadFormat;
  id: string;
  model: string;
}

export type Signal = SignalSignal | SignalNoSignal;

export interface ResponseBody {
  scope_of_exploration: string[];        // doc ids searched
  cost_estimate: number;                 // USD, rolled up
  delay: number;                         // ms end-to-end
  response_text: string;
  response_reasoning: string;
  filtering_reasoning: string;
  signals: Signal[];
}

export interface AletheiaResponse {
  question: string;
  response: ResponseBody;
}
```

Notes on faithful implementation:
- `signal_type` values are `"signal"` and `"no-signal"` (with the hyphen), exactly as PRD.
- `payload_format` appears on **every** signal (including no-signals) per the PRD. It's the same schema across all sub-agents for one question — kept on each signal for self-describing debug output.
- `payload` is the actual instance conforming to `payload_format` — the PRD implies this on the signal variant (the "strongly typed part"); we make it an explicit field to avoid ambiguity. All PRD-named fields are preserved as-is.
- `before_reference_text` / `after_reference_text` MUST be extracted from the real doc body in post-processing, never trusted from the model output. This is core to the verifiability guarantee.
- `ref_fuzzy_distance` is 0–100 per PRD line 46 (fuzzball convention).
- Timeouts: 2min soft (if ≥90% done), 5min hard cap (PRD lines 99–102).
- Threshold defaults (PRD lines 104–106): `accuracy_pass_enforced = true`, `ref_fuzzy_distance_cutoff = 80`.

---

## Decisions locked with user

- **Stack**: TypeScript + **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) for sub-agents. **Next.js 15 App Router with Server Actions** for the web UI. Node 20+, pnpm.
- **Sample data**: Generate a synthetic corpus of ~10 meeting transcripts for a fictional company **"Voxly"** (sells customer-help voice agents). Transcripts are turn-taking speaker dialogs. Include a **golden set** (labelled question → expected scope/signals/answer) and an **EVALS harness**.
- **Interface**: CLI (`pnpm aletheia ask "..."`) **and** a minimal Next.js web UI with drill-down signal cards.
- **Accuracy check**: hybrid — deterministic heuristic first (fuzzball ≥ threshold + payload validates against payload_format schema), LLM adjudication only for borderline cases (fuzzball 70–90 OR confidence 0.5–0.7).

---

## Tech stack

- **Runtime**: Node 20+, TypeScript 5.5+, pnpm
- **Framework**: Next.js 15 (App Router, Server Actions) — serves both the web UI and hosts the orchestrator in server-side functions the CLI can also call
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` — one SDK `query()` per sub-agent, in parallel via `Promise.all` with timeout logic
- **Structured output**: sub-agents use a **custom MCP tool** `emit_signals` created via `createSdkMcpServer` + `tool()`; the sub-agent's SDK options set `allowedTools: ["emit_signals"]` and a system prompt that forces the tool call. The tool's Zod schema encodes `payload_format` for that run.
- **Validation**: `zod` for schemas, matching pydantic parity from the earlier draft
- **Fuzzy match**: `fastest-levenshtein` + a partial-match helper (or `fuse.js` if we need windowed scoring); target parity with rapidfuzz's `partial_ratio`
- **Prompt caching**: enable Anthropic prompt caching on the sub-agent system prompt (payload_format + instructions); N sub-agents in one question run share the cached prefix
- **UI**: Next.js App Router + Tailwind + shadcn/ui for signal cards; Server Actions call the orchestrator directly (no separate API layer)
- **CLI**: `tsx bin/aletheia.ts` or a `pnpm aletheia` script; imports the same orchestrator module the Server Action uses

---

## Repo layout

```
aletheia-knowledge-explorer-agent/
├── PRD.md
├── execution_plan.md            (this plan copied over on approval)
├── README.md
├── package.json  pnpm-workspace.yaml  tsconfig.json  .env.example
├── config/
│   └── thresholds.json          (accuracy_pass_enforced, ref_fuzzy_distance_cutoff, timeouts, models per role)
├── knowledge-base/              (production docs land here at runtime)
├── examples/
│   └── voxly-corpus/            (~10 synthetic meeting transcript JSON docs, versioned)
├── evals/
│   ├── golden-set.json          (questions + expected scope / signals / answer keywords)
│   ├── run-evals.ts             (harness: runs every question, prints precision/recall/verifiability/cost table)
│   └── report/                  (gitignored: last-run reports)
├── src/
│   ├── core/
│   │   ├── orchestrator.ts      (PRD's 7-step loop)
│   │   ├── subagent.ts          (per-doc SDK query + post-processing)
│   │   ├── knowledge-base.ts    (metadata listing, single-body loader)
│   │   ├── scoring.ts           (fuzzball, before/after extraction, heuristic accuracy)
│   │   ├── llm.ts               (Anthropic wrapper for orchestrator LLM calls: filter/rescope/aggregate/judge)
│   │   ├── cost.ts              (token → $ table, per-signal + per-response rollup)
│   │   ├── config.ts            (thresholds + models loader)
│   │   ├── types.ts             (Signal, NoSignal, Response, DocMeta, PayloadFormat)
│   │   └── mcp/
│   │       └── emit-signals.ts  (createSdkMcpServer + tool() with dynamic zod payload_format)
│   ├── app/                     (Next.js App Router)
│   │   ├── layout.tsx  page.tsx
│   │   ├── actions.ts           ('use server' — askAletheia(question))
│   │   └── components/
│   │       ├── QuestionForm.tsx
│   │       ├── ResponseView.tsx
│   │       └── SignalCard.tsx   (expandable: reference w/ before/after highlighted, fuzz meter, cost, model, source link)
│   └── bin/
│       └── aletheia.ts          (CLI entry: `aletheia ask "..."`, `aletheia evals`, `aletheia list-docs`)
└── tests/                       (vitest)
    ├── scoring.test.ts
    ├── knowledge-base.test.ts
    ├── subagent.test.ts         (mocked SDK)
    └── orchestrator.test.ts     (mocked sub-agents, exercises timeout branches)
```

---

## Component design

### `knowledge-base.ts`

- `listMetadata(): Promise<DocMeta[]>` — reads each `knowledge-base/*.json`, projects `{id, metadata}` only. `body` never enters the returned objects.
- `loadBody(docId: string): Promise<string>` — reads one file, returns `body`. Called by each sub-agent exactly once for its own doc.
- Invariant test: `listMetadata()` output must not contain any `body` key at any depth.

### `core/orchestrator.ts`

Implements PRD steps 1–7:

1. **Filter** — one LLM call with all metadata + question → `scope_of_exploration: string[]` + reasoning.
2. **Rescope + payload_format** — combined LLM call → `question_rescoped: string` + `payload_format: JSONSchema`.
3. **Fan out** — one Claude Agent SDK `query()` per doc, `Promise.all` with a soft-timeout wrapper.
4. **Timeouts** — race against two deadlines: at 2min if ≥90% resolved, cancel the rest; hard cancel at 5min. Unresolved doc IDs are captured in the debug payload.
5. **Filter signals** — apply thresholds from `config/thresholds.json`; capture `filtering_reasoning`.
6. **Aggregate** — final LLM call: signals → `response_text` + `response_reasoning`.
7. **Assemble** — pack the full `Response` object (data model in PRD) and return.

### `core/subagent.ts`

`runSubagent({ docId, questionRescoped, payloadFormat, model }): Promise<Signal[] | NoSignal>`

- `loadBody(docId)` → body string.
- Build an in-process SDK MCP server via `createSdkMcpServer` exposing one `tool('emit_signals', payloadFormatZodSchema, handler)`. The handler simply captures the tool input and returns success — the SDK then completes the turn.
- Call `query({ prompt, options: { mcpServers, allowedTools: ["emit_signals"], systemPrompt, model, ... } })`.
- The system prompt: "You are given ONE document body. Emit signals via the `emit_signals` tool. If the doc has no relevant content, emit `{kind:'no_signal'}`. Do not use any other tools. Do not reference other documents." Prompt-caches the schema/system portion.
- Post-process each returned signal:
  - `rapidfuzz-equivalent.partial_ratio(reference_text, body)` → `ref_fuzzy_distance`
  - Deterministically extract `before_reference_text` / `after_reference_text` from the **body** around the best fuzzy match window (do NOT trust model-provided context).
  - Heuristic accuracy: reference must fuzz ≥ hard-pass threshold AND payload matches `payload_format` schema.
  - If borderline (fuzz 70–90 or confidence 0.5–0.7), run LLM judge with Haiku → `accuracy_pass`.
  - Attach `cost_estimate` from usage; propagate `model`.

### `core/scoring.ts`

- `fuzzball(reference, body): number` — partial-match ratio 0–100.
- `extractContext(reference, body, window=200)`: locate best match in body, return `{before, after}` slices of surrounding sentences.
- `heuristicAccuracy(signal, body, payloadFormat): 'pass' | 'fail' | 'borderline'`.
- `llmAccuracy(signal, body): Promise<boolean>` — Haiku judge, used only for borderline.

### `core/mcp/emit-signals.ts`

Builds a fresh SDK MCP server per sub-agent run because the tool's zod schema is question-specific (derived from `payload_format`). Uses `createSdkMcpServer({ name:'aletheia-signals', tools:[tool('emit_signals', schema, handler)] })` per docs on `@anthropic-ai/claude-agent-sdk`.

### `core/cost.ts`

Hardcoded price table per model (input/output $/MTok). Function: `usageToCost(usage, model) -> number` in USD. Rolled up per signal, per sub-agent turn, per response.

---

## Synthetic corpus: Voxly meeting transcripts

Fictional company: **Voxly** — sells AI voice agents for customer support. Corpus is discovery calls, QBRs, expansion talks, churn saves, feature-request syncs, kickoffs. Each doc is one meeting.

**Doc schema** (`examples/voxly-corpus/<id>.json`):

```jsonc
{
  "id": "mtg-2026-06-15-acme-discovery",
  "metadata": {
    "type": "meeting_transcript",
    "customer": { "id": "acme-corp", "name": "Acme Corp", "tier": "enterprise" },
    "date": "2026-06-15",
    "duration_minutes": 42,
    "meeting_type": "discovery_call",
    "product_discussed": ["voice_agent_v2"],
    "participants": [
      { "name": "Sarah Chen", "role": "AE",         "company": "Voxly" },
      { "name": "Priya Rao",  "role": "SE",         "company": "Voxly" },
      { "name": "John Miller","role": "VP Support", "company": "Acme Corp" }
    ],
    "topics_tagged": ["pricing", "integration", "compliance"]
  },
  "body": "Sarah: Thanks for joining today...\nJohn: Happy to be here. We've been..."
}
```

- ~10 docs covering pricing objections, integration blockers, expansion signals, competitive mentions, churn risk, feature requests. Deliberately seeded so golden-set questions have clear expected answers.
- Metadata is rich enough that the filter step is meaningful (by customer, date range, meeting_type, topics).

### Golden set (`evals/golden-set.json`)

~15 questions, each with:

```jsonc
{
  "id": "q-001",
  "question": "Which customers raised pricing concerns in the last 6 months?",
  "expected_scope_ids": ["mtg-2026-06-15-acme-discovery", "mtg-2026-05-02-fintrust-qbr"],
  "expected_signal_count_min": 2,
  "expected_answer_must_mention": ["Acme Corp", "Fintrust"],
  "expected_answer_must_not_mention": ["Globex"]
}
```

### EVALS harness (`evals/run-evals.ts`)

For every golden question, runs the orchestrator and reports:

- **Precision** — fraction of returned `scope_of_exploration` that is in `expected_scope_ids`
- **Recall** — fraction of `expected_scope_ids` covered
- **Signal count** — vs `expected_signal_count_min`
- **Verifiability** — mean `ref_fuzzy_distance` across accepted signals + % of signals whose `reference_text` is actually a substring of the referenced doc's body (hard check)
- **Answer coverage** — keyword presence check for must_mention / must_not_mention
- **Latency** and **cost per question**
- **Report** written to `evals/report/<timestamp>.json` + a Markdown summary printed to stdout

---

## Web UI

Single Next.js App Router route:

- `/` — question form (Server Component + Server Action `askAletheia`).
- Response view: `response_text` prominent at top with the aggregated reasoning collapsed by default.
- **Signal cards** below, one per accepted signal:
  - Header: source doc name/id, meeting type, date
  - Reference block: the `before_reference_text`, then the highlighted `reference_text`, then `after_reference_text` — all pulled from the actual body, not the model output
  - Meters: fuzzball score bar (0–100), confidence bar, cost estimate, model chip
  - Expandable: full doc body inline (fetched on demand from `loadBody`)
- Filter chips: `show no-signals`, `show filtered-out signals` (debug mode)
- No auth. Local-only. Tailwind + a few shadcn/ui primitives.

---

## Answers to PRD's open questions

### Q1: "How does the sub-agent know it is done after one signal?"

**Single query, tool-forced schema.** The sub-agent is a **single SDK `query()`** with `allowedTools: ["emit_signals"]` and a system prompt that requires exactly one call to that tool. The tool's zod schema is a discriminated union:

```ts
z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_signal") }),
  z.object({ kind: z.literal("signals"), signals: z.array(payloadFormatSchema) }),
]);
```

The model emits one array (possibly of length ≥ 1) OR the `no_signal` marker. Turn ends when the tool has been called. No "am I still working?" ambiguity — the SDK's turn boundary IS the finish signal.

### Q2: "Metadata-only listing for orchestrator; single-body load per sub-agent?"

**One JSON file per doc, code-level field projection.**

- Files: `knowledge-base/<id>.json` shaped `{ id, metadata:{...}, body:"..." }`.
- `listMetadata()` reads each file and returns `[{ id, metadata }]` — `body` is never included in the dict handed to the orchestrator's LLM prompt.
- `loadBody(docId)` reads one file, returns the string. Each sub-agent's SDK `query()` receives only its own body in the user message.
- Enforcement: unit test asserts `listMetadata()` output has no `body` key at any depth. LLM prompts are built exclusively from the projected dicts.
- Scaling later: split into `<id>.metadata.json` + `<id>.body.json` for genuinely large bodies. Start with the single-file layout.

---

## Verification

- **Unit (vitest)**:
  - `scoring.test.ts` — fuzzball edge cases, before/after extraction boundary conditions
  - `knowledge-base.test.ts` — `listMetadata()` never leaks body
  - `subagent.test.ts` — mocked SDK: assert only `emit_signals` in `allowedTools`, assert body-only user message, assert post-processing fills in fuzz + before/after from body
  - `orchestrator.test.ts` — mocked sub-agents: timeout branches (2min@90%, 5min hard) and threshold filtering paths
- **EVALS**: `pnpm evals` runs the golden set; report file + stdout summary. Target v1: recall ≥ 0.8, verifiability ≥ 90% on hard-substring check.
- **Manual smoke**:
  1. `pnpm aletheia ask "Which customers raised pricing concerns?"` against `examples/voxly-corpus/` — inspect JSON output.
  2. `pnpm dev` → open browser, submit same question, drill into a signal card, confirm `reference_text` is highlighted inside real body context.

---

## Implementation phases

1. **Skeleton** — pnpm init, TS/Next config, `.env.example`, thresholds, empty modules with types.
2. **Data + fixtures** — write the 10 Voxly transcripts + golden-set + one smoke doc.
3. **Core primitives** — `knowledge-base`, `scoring`, `cost`, `config`, `types`.
4. **Sub-agent** — MCP tool factory, SDK `query()` wrapper, post-processing.
5. **Orchestrator** — filter/rescope/fan-out/aggregate; wire timeouts.
6. **CLI** — `aletheia ask`, `aletheia list-docs`, `aletheia evals`.
7. **Web UI** — Server Action + question form + signal cards.
8. **EVALS harness** — run and iterate on prompts until golden-set targets hit.
9. **Docs** — README with quickstart, architecture diagram, and how to add docs.
