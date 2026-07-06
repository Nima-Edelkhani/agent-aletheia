import { loadConfig } from "./config";
import { listMetadata } from "./knowledge-base";
import { callJson } from "./llm";
import { sum } from "./cost";
import { runSubagent } from "./subagent";
import { filterSignals, type DroppedSignalEntry } from "./signal-filter";
export type { DroppedSignalEntry } from "./signal-filter";
import type {
  AletheiaConfig,
  AletheiaResponse,
  AskOptions,
  DocMeta,
  PayloadFormat,
  ProgressEvent,
  ResponseBody,
  Signal,
  SubagentResult,
} from "./types";

type OnProgress = (event: ProgressEvent) => void;
const noop: OnProgress = () => {};

export interface OrchestratorTrace {
  filter_reasoning: string;
  rescope_reasoning: string;
  aggregate_reasoning: string;
  filtering_reasoning: string;
  unresolved_doc_ids: string[];
  per_doc_costs: Record<string, number>;
  per_doc_duration_ms: Record<string, number>;
  errors: Record<string, string>;
  raw_signal_count: number;
  filtered_signal_count: number;
  /**
   * Signals emitted by sub-agents that were dropped in step 6 by threshold
   * filtering (accuracy_pass or ref_fuzzy_distance). Kept out of
   * `response.signals` to honor the PRD contract, but surfaced here so
   * `--debug` mode can show the model's actual output.
   */
  dropped_signals: DroppedSignalEntry[];
  /** All signals the sub-agents emitted before threshold filtering. */
  raw_signals: Signal[];
  /**
   * The threshold values applied by step 6 for THIS run. Included in the
   * trace so the UI can render fuzz and confidence meters with the same
   * red-when-below-cutoff coloring the filter used, and users can see at a
   * glance what a dropped signal was measured against.
   */
  thresholds_applied: {
    ref_fuzzy_distance_cutoff: number;
    confidence_cutoff: number;
    accuracy_pass_enforced: boolean;
  };
  timed_out_soft: boolean;
  timed_out_hard: boolean;
  orchestrator_cost: number;
}

export async function ask(
  question: string,
  onProgress: OnProgress = noop,
  options: AskOptions = {},
): Promise<{
  response: AletheiaResponse;
  trace: OrchestratorTrace;
}> {
  const startedAt = Date.now();
  const config = await loadConfig();
  const metadata = await listMetadata();
  const specifiedFindingFormat = options.specifiedFindingFormat ?? null;
  onProgress({ type: "started", question, kb_size: metadata.length });

  // ---------- Step 1: Filter ----------
  onProgress({ type: "filter_started" });
  const filterResult = await filterStep(question, metadata, config);
  const scope = filterResult.scope_of_exploration;
  onProgress({
    type: "filter_done",
    scope_of_exploration: scope,
    reasoning: filterResult.reasoning,
    cost: filterResult.cost,
  });

  // ---------- Step 2: Rescope (payload_format is no longer synthesized) ----------
  onProgress({ type: "rescope_started" });
  const rescopeResult = await rescopeStep(question, metadata, scope, config);
  const questionRescoped = rescopeResult.question_rescoped;
  onProgress({
    type: "rescope_done",
    question_rescoped: questionRescoped,
    cost: rescopeResult.cost,
  });

  // ---------- Steps 4 & 5: Fan out sub-agents with timeout logic ----------
  onProgress({ type: "fanout_started", doc_ids: scope });
  const fanoutOutcome = await fanoutWithTimeouts(
    scope,
    questionRescoped,
    specifiedFindingFormat,
    config,
    onProgress,
  );
  onProgress({
    type: "fanout_done",
    timed_out_soft: fanoutOutcome.timedOutSoft,
    timed_out_hard: fanoutOutcome.timedOutHard,
  });

  // ---------- Step 6: Filter signals ----------
  const rawSignals = fanoutOutcome.results.flatMap((r) => r.signals);
  const { keptSignals, droppedSignals, filteringReasoning } = filterSignals(
    rawSignals,
    config,
  );
  onProgress({
    type: "signal_filter_done",
    kept: keptSignals.length,
    dropped: droppedSignals.length,
    filtering_reasoning: filteringReasoning,
  });

  // ---------- Step 7: Aggregate into response text ----------
  onProgress({ type: "aggregate_started" });
  const aggregate = await aggregateStep(question, keptSignals, metadata, scope, config);
  onProgress({ type: "aggregate_done", cost: aggregate.cost });

  // ---------- Assemble ----------
  const orchestratorCost = round6(
    filterResult.cost + rescopeResult.cost + aggregate.cost,
  );
  const subagentCosts = fanoutOutcome.results.map((r) => r.cost_estimate);
  const totalCost = round6(orchestratorCost + sum(subagentCosts));

  const responseBody: ResponseBody = {
    scope_of_exploration: scope,
    cost_estimate: totalCost,
    delay: Date.now() - startedAt,
    response_text: aggregate.response_text,
    response_reasoning: aggregate.response_reasoning,
    filtering_reasoning: filteringReasoning,
    signals: keptSignals,
  };

  const response: AletheiaResponse = {
    question,
    response: responseBody,
  };

  const trace: OrchestratorTrace = {
    filter_reasoning: filterResult.reasoning,
    rescope_reasoning: rescopeResult.reasoning,
    aggregate_reasoning: aggregate.response_reasoning,
    filtering_reasoning: filteringReasoning,
    unresolved_doc_ids: fanoutOutcome.unresolved,
    per_doc_costs: Object.fromEntries(
      fanoutOutcome.results.map((r) => [r.doc_id, r.cost_estimate]),
    ),
    per_doc_duration_ms: Object.fromEntries(
      fanoutOutcome.results.map((r) => [r.doc_id, r.duration_ms]),
    ),
    errors: Object.fromEntries(
      fanoutOutcome.results
        .filter((r) => r.error)
        .map((r) => [r.doc_id, r.error as string]),
    ),
    raw_signal_count: rawSignals.length,
    filtered_signal_count: keptSignals.length,
    dropped_signals: droppedSignals,
    raw_signals: rawSignals,
    thresholds_applied: {
      ref_fuzzy_distance_cutoff: config.ref_fuzzy_distance_cutoff,
      confidence_cutoff: config.confidence_cutoff,
      accuracy_pass_enforced: config.accuracy_pass_enforced,
    },
    timed_out_soft: fanoutOutcome.timedOutSoft,
    timed_out_hard: fanoutOutcome.timedOutHard,
    orchestrator_cost: orchestratorCost,
  };

  onProgress({
    type: "finished",
    total_cost: totalCost,
    delay_ms: responseBody.delay,
  });
  return { response, trace };
}

/* ============================================================
 * Step 1: Filter — metadata → scope_of_exploration
 * ============================================================ */

async function filterStep(
  question: string,
  metadata: DocMeta[],
  config: AletheiaConfig,
): Promise<{ scope_of_exploration: string[]; reasoning: string; cost: number }> {
  if (metadata.length === 0) {
    return { scope_of_exploration: [], reasoning: "Knowledge base is empty.", cost: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = [
    "You are the orchestrator's filter step for Aletheia.",
    "Given the user's question and the metadata index for every document in the",
    "knowledge base, produce `scope_of_exploration`: the list of doc IDs that",
    "must be read in detail.",
    "",
    `Today's date is ${today}. Interpret every relative time expression`,
    `("last month", "past 3 weeks", "since March", "past quarter", "in Q1")`,
    "against this date.",
    "",
    "You filter STRICTLY on metadata that is directly derivable from the",
    "structured fields — you never infer topical content from metadata. The",
    "sub-agents will read bodies and decide what's relevant.",
    "",
    "Rules for constructing scope_of_exploration:",
    "",
    "  1. TIME FILTERS are the primary lever. If the question specifies a time",
    "     range (relative or absolute), include EVERY document whose `date`",
    "     falls in that range, and EXCLUDE every document that falls outside.",
    "     This is a strict inclusion + exclusion — do not prune within the",
    "     time window and do not extend beyond it.",
    "",
    "  2. STRUCTURED-METADATA FILTERS also gate scope when the question names",
    "     them explicitly: customer name, customer tier, meeting_type,",
    "     product_discussed, participant role. Combine these with the time",
    "     filter via AND (a doc must satisfy both to be in scope).",
    "",
    "  3. If the question has NO time filter and NO structured filter, include",
    "     every document. The sub-agents will decide what's relevant.",
    "",
    "  4. DO NOT try to infer topical relevance from metadata. Questions like",
    "     'about pricing', 'discussed integrations', 'raised concerns' cannot",
    "     be answered from metadata alone — always defer to the sub-agents by",
    "     leaving any doc that passes the time + structured filters in scope.",
    "     When unsure, INCLUDE.",
    "",
    "  5. Return doc IDs verbatim from the metadata index.",
  ].join("\n");

  const userMessage = [
    `Today's date: ${today}`,
    "",
    "# User question",
    question,
    "",
    "# Metadata index",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "Compute scope_of_exploration per the rules. Reasoning should name the",
    "hard filter(s) you identified (if any) and how each in-scope doc satisfies",
    "them.",
  ].join("\n");

  const result = await callJson<{ scope_of_exploration: string[]; reasoning: string }>({
    model: config.models.filter,
    systemPrompt,
    userMessage,
    toolName: "report_scope",
    toolDescription: "Report the filtered document scope for exploration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["scope_of_exploration", "reasoning"],
      properties: {
        scope_of_exploration: {
          type: "array",
          items: { type: "string" },
          description: "Doc IDs to explore in detail.",
        },
        reasoning: { type: "string" },
      },
    },
  });

  const validIds = new Set(metadata.map((m) => m.id));
  const scope = result.data.scope_of_exploration.filter((id) => validIds.has(id));
  return {
    scope_of_exploration: scope,
    reasoning: result.data.reasoning,
    cost: result.cost,
  };
}

/* ============================================================
 * Step 2: Rescope (payload_format is NO LONGER synthesized here —
 * every signal now carries finding_summary + finding_category
 * as first-class fields, and typed extraction is driven by the
 * caller-supplied specifiedFindingFormat instead)
 * ============================================================ */

async function rescopeStep(
  question: string,
  metadata: DocMeta[],
  scope: string[],
  config: AletheiaConfig,
): Promise<{
  question_rescoped: string;
  reasoning: string;
  cost: number;
}> {
  const scopedMetadata = metadata.filter((m) => scope.includes(m.id));
  const systemPrompt = [
    "You are the orchestrator's rescope step for Aletheia.",
    "",
    "Rephrase the user's multi-doc question into a single-doc version — the",
    "same question but framed as 'did/does THIS document contain X?' rather",
    "than 'which documents contain X across the corpus?'.",
    "",
    "Example:",
    "  'Which customers raised pricing concerns?' →",
    "  'Did the customer raise pricing concerns in this meeting?'",
    "  'How many meetings mention Twilio integration issues?' →",
    "  'Does this meeting discuss Twilio integration issues?'",
    "",
    "Keep the rescoped question short and neutral. Do not compose a payload",
    "schema — sub-agents always emit finding_summary + finding_category as",
    "first-class fields.",
  ].join("\n");

  const userMessage = [
    "# User question",
    question,
    "",
    "# In-scope document metadata (context only — bodies are not visible here)",
    "```json",
    JSON.stringify(scopedMetadata, null, 2),
    "```",
  ].join("\n");

  const result = await callJson<{
    question_rescoped: string;
    reasoning: string;
  }>({
    model: config.models.rescope,
    systemPrompt,
    userMessage,
    toolName: "report_rescope",
    toolDescription: "Report the single-doc rescoped question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question_rescoped", "reasoning"],
      properties: {
        question_rescoped: { type: "string" },
        reasoning: { type: "string" },
      },
    },
  });

  return {
    question_rescoped: result.data.question_rescoped,
    reasoning: result.data.reasoning,
    cost: result.cost,
  };
}

/* ============================================================
 * Steps 4 & 5: Fan out with soft/hard timeouts
 * ============================================================ */

interface FanoutOutcome {
  results: SubagentResult[];
  unresolved: string[];
  timedOutSoft: boolean;
  timedOutHard: boolean;
}

async function fanoutWithTimeouts(
  scope: string[],
  questionRescoped: string,
  specifiedFindingFormat: PayloadFormat | null,
  config: AletheiaConfig,
  onProgress: OnProgress,
): Promise<FanoutOutcome> {
  if (scope.length === 0) {
    return { results: [], unresolved: [], timedOutSoft: false, timedOutHard: false };
  }

  const resolved = new Map<string, SubagentResult>();

  const tasks = scope.map((docId) => {
    onProgress({ type: "subagent_started", doc_id: docId });
    return runSubagent({
      docId,
      questionRescoped,
      specifiedFindingFormat,
      model: config.models.subagent,
      config,
    })
      .then((r) => {
        resolved.set(docId, r);
        onProgress({
          type: "subagent_done",
          doc_id: docId,
          signal_count: r.signals.filter((s) => s.signal_type === "signal").length,
          no_signal: r.signals.some((s) => s.signal_type === "no-signal"),
          cost: r.cost_estimate,
          duration_ms: r.duration_ms,
          error: r.error,
        });
        return r;
      })
      .catch((err) => {
        const fallback: SubagentResult = {
          doc_id: docId,
          signals: [],
          cost_estimate: 0,
          duration_ms: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        resolved.set(docId, fallback);
        onProgress({
          type: "subagent_done",
          doc_id: docId,
          signal_count: 0,
          no_signal: false,
          cost: 0,
          duration_ms: 0,
          error: fallback.error,
        });
        return fallback;
      });
  });

  const softTimer = new Promise<"soft">((res) =>
    setTimeout(() => res("soft"), config.timeouts_ms.soft_timeout_ms),
  );
  const hardTimer = new Promise<"hard">((res) =>
    setTimeout(() => res("hard"), config.timeouts_ms.hard_timeout_ms),
  );
  const allDone = Promise.all(tasks).then(() => "done" as const);

  let timedOutSoft = false;
  let timedOutHard = false;

  const outcome = await Promise.race([allDone, softTimer, hardTimer]);
  if (outcome === "soft") {
    const doneRatio = resolved.size / scope.length;
    if (doneRatio >= config.timeouts_ms.soft_at_percent_done / 100) {
      timedOutSoft = true;
    } else {
      // Not enough done — wait for hard timeout.
      const secondOutcome = await Promise.race([allDone, hardTimer]);
      if (secondOutcome === "hard") timedOutHard = true;
    }
  } else if (outcome === "hard") {
    timedOutHard = true;
  }

  const unresolved = scope.filter((id) => !resolved.has(id));
  const results = Array.from(resolved.values());
  return { results, unresolved, timedOutSoft, timedOutHard };
}

/* ============================================================
 * Step 7: Aggregate into final response
 * ============================================================ */

async function aggregateStep(
  question: string,
  signals: Signal[],
  metadata: DocMeta[],
  scope: string[],
  config: AletheiaConfig,
): Promise<{ response_text: string; response_reasoning: string; cost: number }> {
  const contributing = signals.filter((s) => s.signal_type === "signal");

  if (contributing.length === 0) {
    return {
      response_text:
        "Aletheia searched the relevant documents but did not find grounded evidence to answer this question.",
      response_reasoning:
        "No sub-agent returned a signal that passed the fuzzy-match and accuracy thresholds. The response is therefore explicitly a no-evidence answer.",
      cost: 0,
    };
  }

  const scopedMetadata = metadata.filter((m) => scope.includes(m.id));

  const systemPrompt = [
    "You are the orchestrator's aggregate step for Aletheia.",
    "",
    "Compose a direct, human-readable answer to the user's question from the",
    "provided signals. Each signal is a positive finding from ONE document,",
    "and carries a `signal_index` (1-based), `finding_summary` (one sentence",
    "from the sub-agent), `finding_category` (a snake_case label the",
    "sub-agent chose), and a verbatim `reference_text` quote from the source.",
    "Some signals may also carry a typed `payload` when the caller requested",
    "extraction.",
    "",
    "You may also use the metadata index for docs in scope (customer name,",
    "date, tier, meeting type) to refer to sources naturally in your answer",
    '(e.g. "Meridian (enterprise) on June 12").',
    "",
    "VERIFIABILITY — EVERY factual claim in `response_text` MUST be cited by",
    "appending inline citation markers of the exact form `[s<index>]` where",
    "<index> is the `signal_index` of the signal that supports that claim.",
    "  - Multiple signals supporting one claim: `[s1][s3]` (no space).",
    "  - Attach the marker immediately after the claim, before punctuation.",
    "  - Example: 'Two customers raised pricing concerns[s1][s3] and one",
    '    asked for Spanish support[s2].\'',
    "  - If a sentence has no citable claim (transitional prose, summarizing",
    "    what you were asked), it needs no marker.",
    "  - NEVER cite a signal_index that is not in the list.",
    "",
    "Do NOT hallucinate content that is not present in the signals or metadata.",
    "Do NOT restate the reference_text verbatim (the UI shows it separately) —",
    "instead, synthesize across the finding_summary values.",
    "",
    "Output:",
    "  - response_text: the answer. Markdown allowed (bold, bullets, small",
    "    tables). Citation markers `[s<n>]` MUST appear inline as literal text.",
    "  - response_reasoning: 2–4 sentences on how you combined the signals.",
  ].join("\n");

  const userMessage = [
    "# User question",
    question,
    "",
    "# Metadata for docs in scope",
    "```json",
    JSON.stringify(scopedMetadata, null, 2),
    "```",
    "",
    "# Signals (cite by `signal_index` as `[s<index>]`)",
    "```json",
    JSON.stringify(
      contributing.map((s, i) => {
        if (s.signal_type !== "signal") return null;
        return {
          signal_index: i + 1,
          scope_of_signal: s.scope_of_signal,
          finding_summary: s.finding_summary,
          finding_category: s.finding_category,
          reference_text: s.reference_text,
          confidence: s.confidence,
          payload: s.payload_format ? s.payload : undefined,
        };
      }),
      null,
      2,
    ),
    "```",
  ].join("\n");

  const result = await callJson<{ response_text: string; response_reasoning: string }>({
    model: config.models.aggregate,
    systemPrompt,
    userMessage,
    toolName: "report_response",
    toolDescription: "Report the aggregated response and reasoning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["response_text", "response_reasoning"],
      properties: {
        response_text: { type: "string" },
        response_reasoning: { type: "string" },
      },
    },
  });

  return {
    response_text: result.data.response_text,
    response_reasoning: result.data.response_reasoning,
    cost: result.cost,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
