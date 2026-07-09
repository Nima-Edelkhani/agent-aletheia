/**
 * Data model for the Aletheia response.
 *
 * `finding_summary` and `finding_category` are first-class required fields
 * on every emitted signal. `payload_format` is null by default and only
 * populated when the caller of `ask()` passes a `specifiedFindingFormat`
 * schema for typed extraction.
 */

export type PayloadFormat = Record<string, unknown>;

/**
 * A single boolean judgment from the accuracy judge, with a short human-
 * readable reason. Reasons are always populated (even on pass) so a
 * reviewer can eyeball the judge's logic when scores are surprising.
 */
export interface AccuracyCheck {
  pass: boolean;
  reason: string;
}

/**
 * The rich verdict from the LLM accuracy judge. Runs on every signal that
 * survives the pre-filter (schema + fuzz cutoff). Signal passes overall
 * only if all three checks pass — logical AND, stored as `overall_pass`
 * and also mirrored to the top-level `accuracy_pass` field on the signal.
 */
export interface AccuracyAdjudication {
  reference_supports_summary: AccuracyCheck;
  summary_addresses_question: AccuracyCheck;
  category_is_sensible: AccuracyCheck;
  overall_pass: boolean;
  cost_estimate: number;
  model: string;
}

export interface SignalSignal {
  signal_type: "signal";
  scope_of_signal: string;
  question_rescoped: string;
  /**
   * Null by default. When the caller passed `specifiedFindingFormat` to
   * `ask()`, this holds that JSON Schema so the signal is self-describing.
   */
  payload_format: PayloadFormat | null;
  id: string;
  reference_text: string;
  before_reference_text: string;
  after_reference_text: string;
  ref_fuzzy_distance: number;
  confidence: number;
  cost_estimate: number;
  model: string;
  accuracy_pass: boolean;
  /** Sub-agent's one-sentence positive finding, present tense. */
  finding_summary: string;
  /** Sub-agent-chosen snake_case category label. Open-string, no enum. */
  finding_category: string;
  /**
   * Empty object `{}` by default. When a `specifiedFindingFormat` was
   * provided by the caller, this holds the extracted values conforming
   * to that schema.
   */
  payload: Record<string, unknown>;
  /**
   * The full 3-check adjudication from the LLM judge. `null` only when
   * the signal never reached the judge (payload schema failure or fuzz
   * below the pre-filter cutoff). When present, `accuracy_pass` mirrors
   * `accuracy_adjudication.overall_pass`.
   */
  accuracy_adjudication: AccuracyAdjudication | null;
}

export interface SignalNoSignal {
  signal_type: "no-signal";
  scope_of_signal: string;
  question_rescoped: string;
  payload_format: PayloadFormat | null;
  id: string;
  model: string;
}

export type Signal = SignalSignal | SignalNoSignal;

export interface ResponseBody {
  scope_of_exploration: string[];
  cost_estimate: number;
  delay: number;
  response_text: string;
  response_reasoning: string;
  filtering_reasoning: string;
  signals: Signal[];
}

export interface AletheiaResponse {
  question: string;
  response: ResponseBody;
}

export interface DocMeta {
  id: string;
  metadata: Record<string, unknown>;
}

export interface StoredDoc extends DocMeta {
  body: string;
}

/**
 * Raw signal shape the sub-agent emits via the emit_signals MCP tool.
 * `payload` is present only when the run had a specifiedFindingFormat.
 */
export interface RawEmittedSignal {
  reference_text: string;
  confidence: number;
  finding_summary: string;
  finding_category: string;
  payload?: Record<string, unknown>;
}

export type SubagentEmission =
  | { kind: "no_signal" }
  | { kind: "signals"; signals: RawEmittedSignal[] };

/** Per-sub-agent result surfaced back to the orchestrator. */
export interface SubagentResult {
  doc_id: string;
  signals: Signal[];
  cost_estimate: number;
  duration_ms: number;
  timed_out?: boolean;
  error?: string;
}

/**
 * Options accepted by the top-level `ask()` entry point.
 */
export interface AskOptions {
  /**
   * Optional JSON Schema fragment. When present, every sub-agent is told to
   * additionally fill a `payload` object conforming to it. Sub-agents whose
   * payload fails validation have `accuracy_pass=false`.
   */
  specifiedFindingFormat?: PayloadFormat;
  /**
   * Optional corpus source. Defaults to the local filesystem source (docs in
   * `knowledge-base/`). Callers pass a source name string ("filesystem",
   * "mcp:notion") — `ask()` resolves it via `resolveCorpusSource`.
   */
  sourceKind?: string;
}

/**
 * Progress events emitted by the orchestrator as it walks the 7 steps.
 * Subscribed to by the CLI (prints one line per event) and the web UI
 * (streams from an SSE route into progress cards).
 */
export type ProgressEvent =
  | {
      type: "started";
      question: string;
      /**
       * Number of docs in the corpus. Present for filesystem sources (known
       * upfront) and omitted for MCP sources where the workspace size is
       * either unknown or too large to enumerate cheaply.
       */
      kb_size?: number;
      /** Which corpus source is answering this question. */
      source_kind?: string;
    }
  | { type: "filter_started" }
  | {
      type: "filter_done";
      scope_of_exploration: string[];
      reasoning: string;
      cost: number;
    }
  | { type: "rescope_started" }
  | {
      type: "rescope_done";
      question_rescoped: string;
      cost: number;
    }
  | { type: "fanout_started"; doc_ids: string[] }
  | { type: "subagent_started"; doc_id: string }
  | {
      type: "subagent_done";
      doc_id: string;
      signal_count: number;
      no_signal: boolean;
      cost: number;
      duration_ms: number;
      error?: string;
    }
  | { type: "fanout_done"; timed_out_soft: boolean; timed_out_hard: boolean }
  | {
      type: "signal_filter_done";
      kept: number;
      dropped: number;
      filtering_reasoning: string;
    }
  | { type: "aggregate_started" }
  | { type: "aggregate_done"; cost: number }
  | { type: "finished"; total_cost: number; delay_ms: number };

/** Threshold and model config loaded from config/thresholds.json. */
export interface AletheiaConfig {
  accuracy_pass_enforced: boolean;
  ref_fuzzy_distance_cutoff: number;
  /**
   * Minimum sub-agent self-reported confidence (0.0–1.0) for a signal to
   * survive filtering. Below this the orchestrator drops the signal;
   * the UI renders it in the "dropped" section with a red confidence meter.
   */
  confidence_cutoff: number;
  timeouts_ms: {
    soft_at_percent_done: number;
    soft_timeout_ms: number;
    hard_timeout_ms: number;
  };
  models: {
    filter: string;
    rescope: string;
    subagent: string;
    accuracy_judge: string;
    aggregate: string;
  };
  context_window: {
    before_max_chars: number;
    after_max_chars: number;
  };
}
