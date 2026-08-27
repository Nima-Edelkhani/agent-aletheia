import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadDoc } from "./knowledge-base";
import { EMIT_SIGNALS_TOOL, makeEmitSignalsServer } from "./mcp/emit-signals";
import {
  extractContext,
  fuzzball,
  preFilterAccuracy,
} from "./scoring";
import { callJson } from "./llm";
import { renderJudgeFewShots } from "./judge-fewshots";
import { overallPass } from "./adjudication";
import { usageToCost } from "./cost";
import type {
  AccuracyAdjudication,
  AletheiaConfig,
  PayloadFormat,
  RawEmittedSignal,
  Signal,
  SignalNoSignal,
  SignalSignal,
  SubagentResult,
} from "./types";

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a sub-agent for the Aletheia verifiable-RAG system.",
  "",
  "You are given ONE document (its metadata AND its body) and ONE rescoped",
  "question. Your job:",
  "",
  "  1. Read the metadata and body carefully.",
  "  2. If — and only if — the body affirmatively answers the rescoped",
  "     question, call the `emit_signals` tool with kind='signals' and one",
  "     signal per distinct finding.",
  "  3. If the body does NOT affirmatively answer the question, call",
  "     `emit_signals` with kind='no_signal'. NEVER emit a 'signal' just to",
  "     report absence — that is what 'no_signal' is for. NEVER emit a",
  "     signal whose finding_summary describes a negative or non-event.",
  "",
  "─── GROUNDING DISCIPLINE — THE MOST IMPORTANT RULE ───",
  "",
  "Every claim in `finding_summary` MUST be traceable to specific words in",
  "`reference_text` OR values in the document's metadata block. If you can't",
  "point at the exact language in `reference_text` (or a field in the metadata)",
  "that supports a specific claim in your summary, DO NOT MAKE THAT CLAIM.",
  "",
  "Concretely:",
  "  - Do not add outcomes, motivations, causes, consequences, urgency,",
  "    severity, magnitudes, dollar figures, dates, participants, or product",
  "    versions that the reference_text does not explicitly state.",
  "  - Do not paraphrase 'we're thinking about the price' as 'the customer",
  "    strongly objected to the pricing' — the strength of the claim must",
  "    match the strength of the quote.",
  "  - Do not synthesize across multiple quotes. Every signal has ONE",
  "    reference_text; the summary describes ONLY what THAT quote says (with",
  "    optional metadata context for names/dates/tiers).",
  "  - Do not infer speaker intent beyond what the quote states literally.",
  "  - Metadata is the ONLY external context you may use. Do not draw on",
  "    world knowledge about what the customer 'probably' means.",
  "",
  "If you find yourself writing a summary richer than the quote can support,",
  "either shorten the summary or find a longer quote that actually supports",
  "it. Do not overstate.",
  "",
  "─── SIGNAL FIELDS ───",
  "",
  "For every signal you emit:",
  "  - `reference_text` MUST be a verbatim quote from the BODY (never the",
  "    metadata, never paraphrased, never truncated with '...'). Pick the",
  "    SHORTEST quote that fully supports the finding — but not so short that",
  "    it needs surrounding context to make sense.",
  "  - `finding_summary` is ONE sentence in your own words, present tense.",
  "    Every noun, verb, and modifier in this sentence must be supported by",
  "    words in the reference_text or by a field in the metadata block. If",
  "    the reference_text says 'we're worried about cost', the summary can",
  "    say 'the customer expressed concern about cost' — it cannot say 'the",
  "    customer is planning to churn over pricing'.",
  "  - `finding_category` is a short snake_case label YOU invent based on",
  "    what the reference_text says. Examples: pricing_uplift_objection,",
  "    twilio_integration_blocker, spanish_support_request. There is no fixed",
  "    vocabulary — pick what fits, but keep it specific (never `misc`,",
  "    `other`, `stuff`, `general`, `concern`).",
  "  - `confidence` is your 0.0–1.0 confidence that this finding truly",
  "    answers the rescoped question. If the reference_text only",
  "    tangentially relates, use a low confidence — don't emit the signal.",
  "  - If a `specified_finding_format` JSON Schema is provided in the user",
  "    message, ALSO fill `payload` conforming to it. Copy metadata-derived",
  "    field values VERBATIM from the metadata block (dates, customer name,",
  "    tier, participants). Do NOT include a `payload` field at all when no",
  "    schema was provided.",
  "",
  "Multi-finding docs: emit multiple signals, one per distinct finding.",
  "Do not bundle unrelated findings into one signal.",
  "",
  "Call `emit_signals` EXACTLY ONCE per turn. Do not call any other tool.",
  "Do not reply with prose.",
].join("\n");

interface RunOptions {
  docId: string;
  questionRescoped: string;
  /**
   * null → default flow. Sub-agent emits finding_summary + finding_category
   *        + reference_text + confidence, no payload.
   * schema → also emit a `payload` object conforming to it.
   */
  specifiedFindingFormat: PayloadFormat | null;
  model: string;
  config: AletheiaConfig;
}

export async function runSubagent(opts: RunOptions): Promise<SubagentResult> {
  const startedAt = Date.now();
  const doc = await loadDoc(opts.docId);
  const { server, capture } = makeEmitSignalsServer(
    opts.specifiedFindingFormat ?? undefined,
  );

  const userMessage = buildUserMessage(
    opts.questionRescoped,
    opts.specifiedFindingFormat,
    doc.metadata,
    doc.body,
  );

  let sdkCost = 0;

  try {
    const q = query({
      prompt: userMessage,
      options: {
        model: opts.model,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        mcpServers: { "aletheia-signals": server },
        allowedTools: [EMIT_SIGNALS_TOOL],
        settingSources: [],
        maxTurns: 3,
        permissionMode: "bypassPermissions",
      },
    });

    let usageCost = 0;
    let finalTotal: number | undefined;

    for await (const msg of q) {
      const anyMsg = msg as unknown as {
        type: string;
        usage?: unknown;
        total_cost_usd?: number;
        message?: { usage?: unknown };
      };
      if (typeof anyMsg.total_cost_usd === "number") {
        finalTotal = anyMsg.total_cost_usd;
      }
      const usage = anyMsg.message?.usage ?? anyMsg.usage;
      if (usage && anyMsg.type !== "result") {
        usageCost += usageToCost(usage as never, opts.model);
      }
    }
    sdkCost = finalTotal ?? usageCost;
  } catch (err) {
    return {
      doc_id: opts.docId,
      signals: [],
      cost_estimate: sdkCost,
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!capture.value) {
    const nosig = buildNoSignal(opts);
    return {
      doc_id: opts.docId,
      signals: [nosig],
      cost_estimate: sdkCost,
      duration_ms: Date.now() - startedAt,
      error: "sub-agent did not emit signals",
    };
  }

  if (capture.value.kind === "no_signal") {
    return {
      doc_id: opts.docId,
      signals: [buildNoSignal(opts)],
      cost_estimate: sdkCost,
      duration_ms: Date.now() - startedAt,
    };
  }

  const finalSignals: Signal[] = [];
  const perSignalCost =
    capture.value.signals.length > 0 ? sdkCost / capture.value.signals.length : 0;
  for (const raw of capture.value.signals) {
    const post = await postProcess(raw, doc.body, opts, perSignalCost);
    finalSignals.push(post);
  }

  return {
    doc_id: opts.docId,
    signals: finalSignals,
    cost_estimate: sdkCost,
    duration_ms: Date.now() - startedAt,
  };
}

function buildUserMessage(
  question: string,
  specifiedFindingFormat: PayloadFormat | null,
  metadata: Record<string, unknown>,
  body: string,
): string {
  const parts: string[] = [
    `# Rescoped question`,
    question,
    ``,
    `# Required per-signal fields`,
    `Every signal MUST include:`,
    `  - reference_text  (verbatim quote from the body)`,
    `  - finding_summary (one sentence in your own words, present tense)`,
    `  - finding_category (short snake_case label you invent)`,
    `  - confidence (0.0–1.0)`,
    ``,
  ];

  if (specifiedFindingFormat) {
    parts.push(
      `# specified_finding_format`,
      `The caller of this run asked for typed extraction. Every signal MUST also`,
      `include a \`payload\` object that STRICTLY conforms to this JSON Schema.`,
      `Copy metadata-derived field values (dates, customer name, tier, participants,`,
      `product, meeting type) VERBATIM from the metadata block below — never infer`,
      `them from the body.`,
      "```json",
      JSON.stringify(specifiedFindingFormat, null, 2),
      "```",
      ``,
    );
  } else {
    parts.push(
      `# No specified_finding_format`,
      `The caller did not request typed extraction. DO NOT include a \`payload\` field.`,
      ``,
    );
  }

  parts.push(
    `# Document metadata`,
    `Use these values VERBATIM for any metadata-derived payload field.`,
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    ``,
    `# Document body`,
    "```",
    body,
    "```",
  );

  return parts.join("\n");
}

function buildNoSignal(opts: RunOptions): SignalNoSignal {
  return {
    signal_type: "no-signal",
    scope_of_signal: opts.docId,
    question_rescoped: opts.questionRescoped,
    payload_format: opts.specifiedFindingFormat,
    id: randomUUID(),
    model: opts.model,
  };
}

async function postProcess(
  raw: RawEmittedSignal,
  body: string,
  opts: RunOptions,
  costPerSignal: number,
): Promise<SignalSignal> {
  const fuzz = fuzzball(raw.reference_text, body);
  const ctx = extractContext(
    raw.reference_text,
    body,
    opts.config.context_window.before_max_chars,
    opts.config.context_window.after_max_chars,
  );

  const provisional: SignalSignal = {
    signal_type: "signal",
    scope_of_signal: opts.docId,
    question_rescoped: opts.questionRescoped,
    payload_format: opts.specifiedFindingFormat,
    id: randomUUID(),
    reference_text: raw.reference_text,
    before_reference_text: ctx.before,
    after_reference_text: ctx.after,
    ref_fuzzy_distance: fuzz,
    confidence: raw.confidence,
    cost_estimate: costPerSignal,
    model: opts.model,
    accuracy_pass: false,
    finding_summary: raw.finding_summary ?? "",
    finding_category: raw.finding_category ?? "",
    payload: raw.payload ?? {},
    accuracy_adjudication: null,
  };

  // Pre-filter: cheap deterministic gates (schema + fuzz cutoff) before we
  // spend money on the LLM judge.
  const pre = preFilterAccuracy(
    provisional,
    opts.specifiedFindingFormat,
    opts.config.ref_fuzzy_distance_cutoff,
  );
  if (!pre.pass) {
    provisional.accuracy_pass = false;
    provisional.accuracy_adjudication = {
      reference_supports_summary: { pass: false, reason: pre.reason },
      summary_addresses_question: { pass: false, reason: "not evaluated — pre-filter failed" },
      category_is_sensible: { pass: false, reason: "not evaluated — pre-filter failed" },
      overall_pass: false,
      cost_estimate: 0,
      model: opts.config.models.accuracy_judge,
    };
    return provisional;
  }

  // 3-check LLM judge — runs on every signal that clears the pre-filter.
  provisional.accuracy_adjudication = await llmAdjudicate3(
    provisional,
    opts.config,
  );
  provisional.accuracy_pass = provisional.accuracy_adjudication.overall_pass;
  // Roll judge cost into the signal's total cost estimate.
  provisional.cost_estimate =
    round6(provisional.cost_estimate + provisional.accuracy_adjudication.cost_estimate);

  return provisional;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/* ────────────────────────── LLM accuracy judge ────────────────────────── */

/**
 * Base of the judge's system prompt — the three-check contract and grading
 * instructions. The few-shot examples are loaded separately from
 * `config/judge-fewshots.json` (see `getJudgeSystemPrompt`) so they can be
 * tuned without editing code.
 */
const JUDGE_SYSTEM_PROMPT_BASE = [
  "You are the accuracy judge for the Aletheia verifiable-RAG system.",
  "",
  "You will be given a candidate signal, extracted by a sub-agent from a single",
  "source document. Your job is to answer THREE independent yes/no questions:",
  "",
  "  1. reference_supports_summary — Does the `finding_summary` follow strictly",
  "     from what is stated in the `reference_text` PLUS its immediate context",
  "     (`before_reference_text` and `after_reference_text`)? Reject paraphrase",
  "     drift, unstated inferences, invented figures, or vibes.",
  "",
  "  2. summary_addresses_question — Does the `finding_summary` directly address",
  "     the `rescoped_question`? Reject findings that are real but off-topic.",
  "",
  "  3. category_is_sensible — Is the `finding_category` a specific, well-formed",
  "     snake_case label that describes THIS finding? Reject generic dumps like",
  "     'stuff', 'general', 'misc', 'other', or labels that don't match the",
  "     summary.",
  "",
  "Return each check as { pass: boolean, reason: string }. `reason` should be",
  "ONE short sentence explaining your verdict — always populate it, even on pass.",
  "",
  "Be strict. When in doubt, fail. It is better to reject a marginal signal than",
  "to launder a false-positive into the final answer.",
].join("\n");

/**
 * Assembles the full judge system prompt: base rules + the few-shot examples
 * rendered from `config/judge-fewshots.json`. Memoized inside
 * `renderJudgeFewShots`, so this is cheap to call per signal, and the string
 * is stable (hence prompt-cacheable). Falls back to base rules only if the
 * few-shot file is unavailable.
 */
async function getJudgeSystemPrompt(): Promise<string> {
  const fewShots = await renderJudgeFewShots();
  return fewShots ? `${JUDGE_SYSTEM_PROMPT_BASE}\n\n${fewShots}` : JUDGE_SYSTEM_PROMPT_BASE;
}

async function llmAdjudicate3(
  signal: SignalSignal,
  config: AletheiaConfig,
): Promise<AccuracyAdjudication> {
  const userMessage = [
    `# rescoped_question`,
    signal.question_rescoped,
    ``,
    `# reference_text`,
    signal.reference_text,
    ``,
    `# before_reference_text`,
    signal.before_reference_text || "(no preceding context)",
    ``,
    `# after_reference_text`,
    signal.after_reference_text || "(no trailing context)",
    ``,
    `# finding_summary`,
    signal.finding_summary,
    ``,
    `# finding_category`,
    signal.finding_category || "(no category)",
    ``,
    `# payload (empty when no specified_finding_format was requested)`,
    "```json",
    JSON.stringify(signal.payload, null, 2),
    "```",
  ].join("\n");

  try {
    const result = await callJson<{
      reference_supports_summary: { pass: boolean; reason: string };
      summary_addresses_question: { pass: boolean; reason: string };
      category_is_sensible: { pass: boolean; reason: string };
    }>({
      model: config.models.accuracy_judge,
      temperature: config.temperatures.accuracy_judge,
      systemPrompt: await getJudgeSystemPrompt(),
      userMessage,
      toolName: "report_adjudication",
      toolDescription:
        "Report the three-check accuracy adjudication for the candidate signal.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "reference_supports_summary",
          "summary_addresses_question",
          "category_is_sensible",
        ],
        properties: {
          reference_supports_summary: checkShape(
            "Does the finding_summary follow strictly from the reference + surrounding context?",
          ),
          summary_addresses_question: checkShape(
            "Does the finding_summary directly address the rescoped_question?",
          ),
          category_is_sensible: checkShape(
            "Is the finding_category specific, snake_case, and matches the finding?",
          ),
        },
      },
    });

    const overall_pass = overallPass(result.data);

    return {
      reference_supports_summary: result.data.reference_supports_summary,
      summary_addresses_question: result.data.summary_addresses_question,
      category_is_sensible: result.data.category_is_sensible,
      overall_pass,
      cost_estimate: result.cost,
      model: result.model,
    };
  } catch (err) {
    // Judge errored — return a failing verdict but preserve the reason so
    // the drill-down UI can surface what went wrong.
    const reason =
      err instanceof Error ? `judge error: ${err.message}` : "judge error";
    return {
      reference_supports_summary: { pass: false, reason },
      summary_addresses_question: { pass: false, reason },
      category_is_sensible: { pass: false, reason },
      overall_pass: false,
      cost_estimate: 0,
      model: config.models.accuracy_judge,
    };
  }
}

/** Shared JSON Schema shape for each of the three sub-checks. */
function checkShape(description: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["pass", "reason"],
    description,
    properties: {
      pass: { type: "boolean" },
      reason: {
        type: "string",
        description:
          "One short sentence explaining the verdict. Always populate, even on pass.",
      },
    },
  };
}
