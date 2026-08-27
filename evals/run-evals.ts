import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ask } from "../src/core/orchestrator";
import { loadBody } from "../src/core/knowledge-base";
import type { SignalSignal, Signal } from "../src/core/types";

/* ────────────────────────── golden-set schema ────────────────────────── */

interface GoldenQuestion {
  id: string;
  question: string;
  /**
   * The doc IDs the metadata-only filter step should return in
   * `scope_of_exploration`. Measured as recall — of these expected docs,
   * what fraction did the filter include? Precision is still computed
   * but not gated (the filter is designed to be inclusive; see README).
   */
  expected_scope_ids: string[];
  /**
   * Substrings that MUST appear in the aggregated `response_text`
   * (case-insensitive). Serves as a keyword proxy that signals grounded
   * in the right meetings actually surfaced in the answer.
   */
  expected_answer_must_mention: string[];
  /**
   * Map of doc_id → minimum number of signals that MUST have that doc as
   * `scope_of_signal` in `response.signals`. Catches "the scope was right
   * but the fan-out returned nothing from one of the expected docs".
   *
   * A doc listed here with count N passes iff `response.signals` contains
   * ≥ N signals whose scope_of_signal equals this doc_id.
   *
   * Suite-wide metric: `mean_signal_count_by_meeting_recall` = fraction of
   * expected meetings that hit their minimum, averaged across questions.
   */
  expected_signals_by_meeting?: Record<string, number>;
}

/* ────────────────────────── report schema ────────────────────────── */

interface MeetingCoverage {
  meeting: string;
  expected_min: number;
  actual: number;
  hit: boolean;
}

interface QuestionReport {
  id: string;
  question: string;
  precision: number;
  recall: number;
  signal_count: number;
  verifiability_mean_fuzz: number;
  verifiability_substring_hit_rate: number;
  /**
   * Judge pass rates measured against `trace.raw_signals` — i.e., against
   * what the sub-agents actually emitted, before the filter dropped anything.
   * Per-question is informational; the pass/fail gate lives on the suite
   * aggregates.
   */
  raw_signal_count: number;
  raw_judge_reference_pass_rate: number;
  raw_judge_question_pass_rate: number;
  raw_judge_category_pass_rate: number;
  raw_judge_overall_pass_rate: number;
  /**
   * Per-question signal-count-by-meeting check. Recall = hits / expected count.
   * `null` when the question has no `expected_signals_by_meeting`.
   */
  signal_count_by_meeting_recall: number | null;
  signal_count_by_meeting_coverage: MeetingCoverage[];
  must_mention_hits: number;
  must_mention_total: number;
  latency_ms: number;
  cost_usd: number;
  response_text: string;
}

interface FullReport {
  ran_at: string;
  mode: "smoke" | "full" | "single";
  question_count: number;
  aggregates: {
    /** Tracked but not gated — the filter is intentionally inclusive. */
    mean_precision: number;
    /** Gated. Filter's "did I miss docs I should have picked?" metric. */
    mean_recall: number;
    /**
     * Averaged over signal-producing questions ONLY (see
     * `questions_with_signals`). Questions with an empty answer have nothing to
     * verify and are excluded so they don't drag the mean to 0.
     */
    mean_verifiability_fuzz: number;
    mean_verifiability_substring_hit_rate: number;
    /** Weighted across ALL raw signals from the whole suite. */
    mean_raw_judge_reference_pass_rate: number;
    mean_raw_judge_question_pass_rate: number;
    mean_raw_judge_category_pass_rate: number;
    mean_raw_judge_overall_pass_rate: number;
    /**
     * For each question with `expected_signals_by_meeting`, we compute
     * (meetings that hit their minimum count) / (total expected meetings).
     * This aggregate is the mean across those questions.
     */
    mean_signal_count_by_meeting_recall: number;
    total_raw_signals: number;
    total_expected_meetings: number;
    /** How many questions produced ≥1 signal — the denominator for the two
     * verifiability means above. */
    questions_with_signals: number;
    mean_latency_ms: number;
    total_cost_usd: number;
  };
  thresholds: Thresholds;
  passed: boolean;
  failures: string[];
  per_question: QuestionReport[];
}

/* ────────────────────────── thresholds + CLI ────────────────────────── */

interface Thresholds {
  /**
   * Recall on `scope_of_exploration` — the filter step's headline metric.
   * Precision is tracked but not gated because the filter prompt is
   * intentionally inclusive.
   */
  min_mean_recall: number;
  min_mean_verifiability_fuzz: number;
  min_mean_verifiability_substring_hit_rate: number;
  min_mean_raw_judge_reference_pass_rate: number;
  min_mean_raw_judge_question_pass_rate: number;
  min_mean_raw_judge_category_pass_rate: number;
  min_mean_raw_judge_overall_pass_rate: number;
  min_mean_signal_count_by_meeting_recall: number;
}
const DEFAULT_THRESHOLDS: Thresholds = {
  min_mean_recall: 0.9,
  min_mean_verifiability_fuzz: 85,
  min_mean_verifiability_substring_hit_rate: 0.85,
  min_mean_raw_judge_reference_pass_rate: 0.85,
  min_mean_raw_judge_question_pass_rate: 0.85,
  min_mean_raw_judge_category_pass_rate: 0.8,
  min_mean_raw_judge_overall_pass_rate: 0.7,
  min_mean_signal_count_by_meeting_recall: 0.9,
};

/**
 * "Smoke" IDs — a representative 3-question subset covering a single-doc
 * date window, a customer-name filter, and a topic-shaped question inside
 * a date window (where the filter step returns a superset and sub-agents
 * narrow). Chosen so a regression in any of the three big code paths (filter
 * step, rescope step, aggregate step) surfaces in a few minutes.
 */
const SMOKE_IDS = ["q-001", "q-006", "q-009"];

interface CliOpts {
  smoke: boolean;
  reportMd: boolean;
  question?: string;
  overrides: Partial<Thresholds>;
}

function parseArgv(argv: string[]): CliOpts {
  const out: CliOpts = { smoke: false, reportMd: false, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") out.smoke = true;
    else if (a === "--report-md") out.reportMd = true;
    else if (a === "--question") out.question = argv[++i];
    else if (a === "--min-recall")
      out.overrides.min_mean_recall = Number(argv[++i]);
    else if (a === "--min-fuzz")
      out.overrides.min_mean_verifiability_fuzz = Number(argv[++i]);
    else if (a === "--min-substring")
      out.overrides.min_mean_verifiability_substring_hit_rate = Number(argv[++i]);
    else if (a === "--min-raw-ref")
      out.overrides.min_mean_raw_judge_reference_pass_rate = Number(argv[++i]);
    else if (a === "--min-raw-q")
      out.overrides.min_mean_raw_judge_question_pass_rate = Number(argv[++i]);
    else if (a === "--min-raw-cat")
      out.overrides.min_mean_raw_judge_category_pass_rate = Number(argv[++i]);
    else if (a === "--min-raw-overall")
      out.overrides.min_mean_raw_judge_overall_pass_rate = Number(argv[++i]);
    else if (a === "--min-meeting-recall")
      out.overrides.min_mean_signal_count_by_meeting_recall = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.error(
    [
      "aletheia evals",
      "",
      "Usage: pnpm evals [flags]",
      "",
      "Flags:",
      "  --smoke                        3-question smoke test (fast)",
      "  --question <id>                Run a single question by ID",
      "  --report-md                    Also write a Markdown report alongside JSON",
      "",
      "  --min-recall <n>               Filter recall (default 0.9)",
      "  --min-fuzz <n>                 Verifiability fuzz threshold (default 85)",
      "  --min-substring <n>            Substring hit rate (default 0.85)",
      "  --min-raw-ref <n>              Sub-agent: reference_supports_summary (default 0.85)",
      "  --min-raw-q <n>                Sub-agent: summary_addresses_question (default 0.85)",
      "  --min-raw-cat <n>              Sub-agent: category_is_sensible (default 0.80)",
      "  --min-raw-overall <n>          Sub-agent: overall_pass (default 0.70)",
      "  --min-meeting-recall <n>       Fraction of expected meetings hitting their minimum",
      "                                 signal count (default 0.90)",
      "",
      "  -h, --help                     Show this help",
      "",
      "Exit codes:",
      "  0   All thresholds passed",
      "  1   One or more thresholds failed",
      "  2   Runtime error (KB missing, API key missing, etc.)",
    ].join("\n"),
  );
}

/* ────────────────────────── per-question run ────────────────────────── */

async function runOne(q: GoldenQuestion): Promise<QuestionReport> {
  const t0 = Date.now();
  const { response, trace } = await ask(q.question);
  const latency = Date.now() - t0;
  const r = response.response;

  const expectedSet = new Set(q.expected_scope_ids);
  const actualSet = new Set(r.scope_of_exploration);
  const truePositives = [...actualSet].filter((id) => expectedSet.has(id)).length;
  const precision = actualSet.size === 0 ? 0 : truePositives / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositives / expectedSet.size;

  const contributing = r.signals.filter(
    (s): s is SignalSignal => s.signal_type === "signal",
  );
  const signalCount = contributing.length;

  // ── Verifiability metrics (measured on the surviving signals in the answer) ──
  let fuzzSum = 0;
  let substringHits = 0;
  for (const s of contributing) {
    fuzzSum += s.ref_fuzzy_distance;
    try {
      const body = await loadBody(s.scope_of_signal);
      if (
        body.toLowerCase().includes(s.reference_text.toLowerCase().slice(0, 60))
      ) {
        substringHits++;
      }
    } catch {
      /* ignore */
    }
  }
  const meanFuzz = signalCount > 0 ? fuzzSum / signalCount : 0;
  const substringRate = signalCount > 0 ? substringHits / signalCount : 0;

  // ── Judge pass rates measured on RAW signals from the trace ──
  const rawContributing = trace.raw_signals.filter(
    (s: Signal): s is SignalSignal => s.signal_type === "signal",
  );
  const rawJudged = rawContributing.filter((s) => s.accuracy_adjudication);
  const rawDenom = rawJudged.length || 1;
  // Defensive: a malformed adjudication (e.g. judge omitted a sub-check under
  // the strict schema) counts as fail for that sub-check rather than
  // crashing the entire per-question run.
  const rawRefPass = rawJudged.filter(
    (s) => s.accuracy_adjudication?.reference_supports_summary?.pass === true,
  ).length;
  const rawQPass = rawJudged.filter(
    (s) => s.accuracy_adjudication?.summary_addresses_question?.pass === true,
  ).length;
  const rawCatPass = rawJudged.filter(
    (s) => s.accuracy_adjudication?.category_is_sensible?.pass === true,
  ).length;
  const rawOverallPass = rawJudged.filter(
    (s) => s.accuracy_adjudication?.overall_pass === true,
  ).length;

  // ── Signal-count-by-meeting check ──
  const coverage: MeetingCoverage[] = [];
  if (q.expected_signals_by_meeting) {
    for (const [meeting, expectedMin] of Object.entries(
      q.expected_signals_by_meeting,
    )) {
      const actual = contributing.filter(
        (s) => s.scope_of_signal === meeting,
      ).length;
      coverage.push({
        meeting,
        expected_min: expectedMin,
        actual,
        hit: actual >= expectedMin,
      });
    }
  }
  const meetingRecall =
    coverage.length === 0
      ? null
      : coverage.filter((c) => c.hit).length / coverage.length;

  const text = r.response_text.toLowerCase();
  const mustMentionHits = q.expected_answer_must_mention.filter((t) =>
    text.includes(t.toLowerCase()),
  ).length;

  return {
    id: q.id,
    question: q.question,
    precision: round3(precision),
    recall: round3(recall),
    signal_count: signalCount,
    verifiability_mean_fuzz: round1(meanFuzz),
    verifiability_substring_hit_rate: round3(substringRate),
    raw_signal_count: rawContributing.length,
    raw_judge_reference_pass_rate: round3(rawRefPass / rawDenom),
    raw_judge_question_pass_rate: round3(rawQPass / rawDenom),
    raw_judge_category_pass_rate: round3(rawCatPass / rawDenom),
    raw_judge_overall_pass_rate: round3(rawOverallPass / rawDenom),
    signal_count_by_meeting_recall:
      meetingRecall === null ? null : round3(meetingRecall),
    signal_count_by_meeting_coverage: coverage,
    must_mention_hits: mustMentionHits,
    must_mention_total: q.expected_answer_must_mention.length,
    latency_ms: latency,
    cost_usd: r.cost_estimate,
    response_text: r.response_text,
  };
}

/* ────────────────────────── main ────────────────────────── */

export default async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...opts.overrides };

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[evals] ANTHROPIC_API_KEY is not set.");
    process.exit(2);
  }

  const goldenPath = resolve(process.cwd(), "evals/golden-set.json");
  const goldenRaw = await readFile(goldenPath, "utf8").catch(() => {
    console.error(`[evals] Golden set not found at ${goldenPath}.`);
    process.exit(2);
  });
  const allQuestions = JSON.parse(goldenRaw as string) as GoldenQuestion[];

  let questions: GoldenQuestion[];
  let mode: FullReport["mode"];
  if (opts.question) {
    const found = allQuestions.find((q) => q.id === opts.question);
    if (!found) {
      console.error(`[evals] Question ${opts.question} not found in golden set.`);
      process.exit(2);
    }
    questions = [found];
    mode = "single";
  } else if (opts.smoke) {
    questions = allQuestions.filter((q) => SMOKE_IDS.includes(q.id));
    if (questions.length === 0) {
      questions = allQuestions.slice(0, 3);
    }
    mode = "smoke";
  } else {
    questions = allQuestions;
    mode = "full";
  }

  console.error(
    `[evals] Mode: ${mode}. Running ${questions.length} question(s).\n`,
  );

  const reports: QuestionReport[] = [];
  for (const q of questions) {
    console.error(`[evals] ${q.id}  ${q.question}`);
    try {
      const r = await runOne(q);
      reports.push(r);
      const meetingCell =
        r.signal_count_by_meeting_recall === null
          ? "—"
          : `${r.signal_count_by_meeting_coverage.filter((c) => c.hit).length}/${r.signal_count_by_meeting_coverage.length}`;
      console.error(
        `        r=${r.recall} signals=${r.signal_count} ` +
          `fuzz=${r.verifiability_mean_fuzz} substr=${r.verifiability_substring_hit_rate} ` +
          `raw_ref=${r.raw_judge_reference_pass_rate} raw_overall=${r.raw_judge_overall_pass_rate} ` +
          `meeting_cov=${meetingCell} cost=$${r.cost_usd.toFixed(4)} ` +
          `elapsed=${(r.latency_ms / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error(
        `        ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Aggregate metrics ──
  const totalRawSignals = reports.reduce((a, r) => a + r.raw_signal_count, 0);
  const weightedRawJudgeRate = (getter: (r: QuestionReport) => number): number => {
    if (totalRawSignals === 0) return 0;
    return (
      reports.reduce(
        (a, r) => a + getter(r) * r.raw_signal_count,
        0,
      ) / totalRawSignals
    );
  };

  // Verifiability (fuzz + substring) is only meaningful for questions that
  // actually produced signals. A legitimately empty answer (e.g. "no meetings
  // in that window") has nothing to verify, so it must NOT contribute a 0 that
  // drags the suite mean down. Average these metrics over signal-producing
  // questions only, and skip their thresholds entirely when there are none.
  const questionsWithSignals = reports.filter((r) => r.signal_count > 0);

  const questionsWithMeetingCheck = reports.filter(
    (r) => r.signal_count_by_meeting_recall !== null,
  );
  const meanMeetingRecall =
    questionsWithMeetingCheck.length === 0
      ? 0
      : mean(
          questionsWithMeetingCheck.map((r) => r.signal_count_by_meeting_recall!),
        );
  const totalExpectedMeetings = reports.reduce(
    (a, r) => a + r.signal_count_by_meeting_coverage.length,
    0,
  );

  const aggregates: FullReport["aggregates"] = {
    mean_precision: round3(mean(reports.map((r) => r.precision))),
    mean_recall: round3(mean(reports.map((r) => r.recall))),
    mean_verifiability_fuzz: round1(
      mean(questionsWithSignals.map((r) => r.verifiability_mean_fuzz)),
    ),
    mean_verifiability_substring_hit_rate: round3(
      mean(questionsWithSignals.map((r) => r.verifiability_substring_hit_rate)),
    ),
    mean_raw_judge_reference_pass_rate: round3(
      weightedRawJudgeRate((r) => r.raw_judge_reference_pass_rate),
    ),
    mean_raw_judge_question_pass_rate: round3(
      weightedRawJudgeRate((r) => r.raw_judge_question_pass_rate),
    ),
    mean_raw_judge_category_pass_rate: round3(
      weightedRawJudgeRate((r) => r.raw_judge_category_pass_rate),
    ),
    mean_raw_judge_overall_pass_rate: round3(
      weightedRawJudgeRate((r) => r.raw_judge_overall_pass_rate),
    ),
    mean_signal_count_by_meeting_recall: round3(meanMeetingRecall),
    total_raw_signals: totalRawSignals,
    total_expected_meetings: totalExpectedMeetings,
    questions_with_signals: questionsWithSignals.length,
    mean_latency_ms: Math.round(mean(reports.map((r) => r.latency_ms))),
    total_cost_usd: round4(reports.reduce((a, r) => a + r.cost_usd, 0)),
  };

  const failures = evaluateThresholds(aggregates, thresholds, {
    hasMeetingCheck: questionsWithMeetingCheck.length > 0,
    hasRawJudged: totalRawSignals > 0,
    hasVerifiableSignals: questionsWithSignals.length > 0,
  });

  const full: FullReport = {
    ran_at: new Date().toISOString(),
    mode,
    question_count: reports.length,
    aggregates,
    thresholds,
    passed: failures.length === 0,
    failures,
    per_question: reports,
  };

  const reportDir = resolve(process.cwd(), "evals/report");
  await mkdir(reportDir, { recursive: true });
  const stamp = full.ran_at.replace(/[:.]/g, "-");
  const jsonOut = resolve(reportDir, `${stamp}.json`);
  await writeFile(jsonOut, JSON.stringify(full, null, 2), "utf8");

  if (opts.reportMd) {
    const mdOut = resolve(reportDir, `${stamp}.md`);
    await writeFile(mdOut, renderMarkdown(full), "utf8");
    console.error(`[evals] Wrote ${mdOut}`);
  }

  console.error("\n[evals] Aggregates:");
  console.error(JSON.stringify(aggregates, null, 2));
  if (failures.length > 0) {
    console.error("\n[evals] THRESHOLD FAILURES:");
    failures.forEach((f) => console.error("  ✗ " + f));
  } else {
    console.error("\n[evals] ✓ All thresholds passed.");
  }
  console.error(`\n[evals] Wrote ${jsonOut}`);

  if (mode !== "single" && !full.passed) {
    process.exit(1);
  }
}

/* ────────────────────────── helpers ────────────────────────── */

function evaluateThresholds(
  aggregates: FullReport["aggregates"],
  t: Thresholds,
  ctx: {
    hasMeetingCheck: boolean;
    hasRawJudged: boolean;
    hasVerifiableSignals: boolean;
  },
): string[] {
  const failures: string[] = [];
  if (aggregates.mean_recall < t.min_mean_recall) {
    failures.push(
      `mean_recall ${aggregates.mean_recall} < ${t.min_mean_recall}`,
    );
  }
  // Only gate verifiability when at least one question produced signals —
  // otherwise the means are computed over an empty set and carry no signal.
  if (ctx.hasVerifiableSignals) {
    if (aggregates.mean_verifiability_fuzz < t.min_mean_verifiability_fuzz) {
      failures.push(
        `mean_verifiability_fuzz ${aggregates.mean_verifiability_fuzz} < ${t.min_mean_verifiability_fuzz}`,
      );
    }
    if (
      aggregates.mean_verifiability_substring_hit_rate <
      t.min_mean_verifiability_substring_hit_rate
    ) {
      failures.push(
        `mean_verifiability_substring_hit_rate ${aggregates.mean_verifiability_substring_hit_rate} < ${t.min_mean_verifiability_substring_hit_rate}`,
      );
    }
  }
  if (ctx.hasRawJudged) {
    if (
      aggregates.mean_raw_judge_reference_pass_rate <
      t.min_mean_raw_judge_reference_pass_rate
    ) {
      failures.push(
        `mean_raw_judge_reference_pass_rate ${aggregates.mean_raw_judge_reference_pass_rate} < ${t.min_mean_raw_judge_reference_pass_rate}`,
      );
    }
    if (
      aggregates.mean_raw_judge_question_pass_rate <
      t.min_mean_raw_judge_question_pass_rate
    ) {
      failures.push(
        `mean_raw_judge_question_pass_rate ${aggregates.mean_raw_judge_question_pass_rate} < ${t.min_mean_raw_judge_question_pass_rate}`,
      );
    }
    if (
      aggregates.mean_raw_judge_category_pass_rate <
      t.min_mean_raw_judge_category_pass_rate
    ) {
      failures.push(
        `mean_raw_judge_category_pass_rate ${aggregates.mean_raw_judge_category_pass_rate} < ${t.min_mean_raw_judge_category_pass_rate}`,
      );
    }
    if (
      aggregates.mean_raw_judge_overall_pass_rate <
      t.min_mean_raw_judge_overall_pass_rate
    ) {
      failures.push(
        `mean_raw_judge_overall_pass_rate ${aggregates.mean_raw_judge_overall_pass_rate} < ${t.min_mean_raw_judge_overall_pass_rate}`,
      );
    }
  }
  if (ctx.hasMeetingCheck) {
    if (
      aggregates.mean_signal_count_by_meeting_recall <
      t.min_mean_signal_count_by_meeting_recall
    ) {
      failures.push(
        `mean_signal_count_by_meeting_recall ${aggregates.mean_signal_count_by_meeting_recall} < ${t.min_mean_signal_count_by_meeting_recall}`,
      );
    }
  }
  return failures;
}

function renderMarkdown(full: FullReport): string {
  const t = full.thresholds;
  const a = full.aggregates;
  const status = full.passed ? "✅ PASSED" : "❌ FAILED";

  const lines: string[] = [];
  lines.push(`# Aletheia Evals — ${full.ran_at}`);
  lines.push("");
  lines.push(
    `**Mode**: \`${full.mode}\` · **Questions**: ${full.question_count} · **Status**: ${status}`,
  );
  lines.push("");

  lines.push("## Filter step (measured on scope_of_exploration)");
  lines.push("");
  lines.push("| Metric | Value | Threshold |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Mean precision | ${a.mean_precision} | tracked · not gated |`);
  lines.push(`| Mean recall | ${a.mean_recall} | ≥ ${t.min_mean_recall} |`);
  lines.push("");

  lines.push("## Verifiability (measured on filtered response.signals)");
  lines.push("");
  lines.push(
    `_Averaged over the ${a.questions_with_signals} of ${full.question_count} ` +
      `question(s) that produced signals; empty-answer questions are excluded._`,
  );
  lines.push("");
  lines.push("| Metric | Value | Threshold |");
  lines.push("| --- | ---: | ---: |");
  lines.push(
    `| Mean fuzz | ${a.mean_verifiability_fuzz} | ≥ ${t.min_mean_verifiability_fuzz} |`,
  );
  lines.push(
    `| Mean substring hit rate | ${a.mean_verifiability_substring_hit_rate} | ≥ ${t.min_mean_verifiability_substring_hit_rate} |`,
  );
  lines.push("");

  lines.push("## Sub-agent quality (judge pass rates on raw_signals)");
  lines.push("");
  lines.push(
    `_Weighted across ${a.total_raw_signals} raw signals from all questions._`,
  );
  lines.push("");
  lines.push("| Check | Value | Threshold |");
  lines.push("| --- | ---: | ---: |");
  lines.push(
    `| reference_supports_summary | ${a.mean_raw_judge_reference_pass_rate} | ≥ ${t.min_mean_raw_judge_reference_pass_rate} |`,
  );
  lines.push(
    `| summary_addresses_question | ${a.mean_raw_judge_question_pass_rate} | ≥ ${t.min_mean_raw_judge_question_pass_rate} |`,
  );
  lines.push(
    `| category_is_sensible | ${a.mean_raw_judge_category_pass_rate} | ≥ ${t.min_mean_raw_judge_category_pass_rate} |`,
  );
  lines.push(
    `| overall_pass | ${a.mean_raw_judge_overall_pass_rate} | ≥ ${t.min_mean_raw_judge_overall_pass_rate} |`,
  );
  lines.push("");

  if (a.total_expected_meetings > 0) {
    lines.push(
      "## Answer coverage — signal count by meeting (in response.signals)",
    );
    lines.push("");
    lines.push(
      `_Across ${a.total_expected_meetings} expected meetings, what fraction hit their minimum signal count?_`,
    );
    lines.push("");
    lines.push("| Metric | Value | Threshold |");
    lines.push("| --- | ---: | ---: |");
    lines.push(
      `| mean_signal_count_by_meeting_recall | ${a.mean_signal_count_by_meeting_recall} | ≥ ${t.min_mean_signal_count_by_meeting_recall} |`,
    );
    lines.push("");
  }

  lines.push("## Cost & latency");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Mean latency (ms) | ${a.mean_latency_ms} |`);
  lines.push(`| Total cost (USD) | $${a.total_cost_usd.toFixed(4)} |`);
  lines.push("");

  if (full.failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    full.failures.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }

  lines.push("## Per-question");
  lines.push("");
  lines.push(
    "| ID | Precision | Recall | Signals (raw) | Fuzz | Substr | Raw judge ref/q/cat/overall | Meeting coverage | Cost | Latency (s) |",
  );
  lines.push(
    "| --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | ---: | ---: |",
  );
  for (const r of full.per_question) {
    const judgeCell = `${r.raw_judge_reference_pass_rate} / ${r.raw_judge_question_pass_rate} / ${r.raw_judge_category_pass_rate} / ${r.raw_judge_overall_pass_rate}`;
    const meetingCell =
      r.signal_count_by_meeting_recall === null
        ? "—"
        : `${r.signal_count_by_meeting_coverage.filter((c) => c.hit).length}/${r.signal_count_by_meeting_coverage.length} (${r.signal_count_by_meeting_recall})`;
    lines.push(
      `| ${r.id} | ${r.precision} | ${r.recall} | ${r.signal_count} (${r.raw_signal_count}) | ${r.verifiability_mean_fuzz} | ${r.verifiability_substring_hit_rate} | ${judgeCell} | ${meetingCell} | $${r.cost_usd.toFixed(4)} | ${(r.latency_ms / 1000).toFixed(1)} |`,
    );
  }
  lines.push("");

  if (a.total_expected_meetings > 0) {
    lines.push("## Per-question meeting-coverage detail");
    lines.push("");
    for (const r of full.per_question) {
      if (r.signal_count_by_meeting_coverage.length === 0) continue;
      lines.push(`### ${r.id}`);
      lines.push("");
      lines.push("| Meeting | Expected min | Actual | Hit |");
      lines.push("| --- | ---: | ---: | :---: |");
      for (const c of r.signal_count_by_meeting_coverage) {
        lines.push(`| ${c.meeting} | ${c.expected_min} | ${c.actual} | ${c.hit ? "✅" : "❌"} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function mean(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
