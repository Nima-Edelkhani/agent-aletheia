import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ask } from "../src/core/orchestrator";
import { loadBody } from "../src/core/knowledge-base";

interface GoldenQuestion {
  id: string;
  question: string;
  expected_scope_ids: string[];
  expected_signal_count_min: number;
  expected_answer_must_mention: string[];
  expected_answer_must_not_mention: string[];
}

interface QuestionReport {
  id: string;
  question: string;
  precision: number;
  recall: number;
  signal_count: number;
  signal_count_ok: boolean;
  verifiability_mean_fuzz: number;
  verifiability_substring_hit_rate: number;
  /** Fraction of returned signals where the judge marked reference_supports_summary=pass. */
  judge_reference_pass_rate: number;
  /** Fraction of returned signals where the judge marked summary_addresses_question=pass. */
  judge_question_pass_rate: number;
  /** Fraction of returned signals where the judge marked category_is_sensible=pass. */
  judge_category_pass_rate: number;
  /** Fraction of returned signals where the judge's overall_pass was true. */
  judge_overall_pass_rate: number;
  must_mention_hits: number;
  must_mention_total: number;
  must_not_mention_hits: number;
  latency_ms: number;
  cost_usd: number;
  response_text: string;
}

interface FullReport {
  ran_at: string;
  mode: "smoke" | "full" | "single";
  question_count: number;
  aggregates: {
    mean_precision: number;
    mean_recall: number;
    mean_verifiability_fuzz: number;
    mean_verifiability_substring_hit_rate: number;
    mean_judge_reference_pass_rate: number;
    mean_judge_question_pass_rate: number;
    mean_judge_category_pass_rate: number;
    mean_judge_overall_pass_rate: number;
    mean_latency_ms: number;
    total_cost_usd: number;
  };
  thresholds: Thresholds;
  passed: boolean;
  failures: string[];
  per_question: QuestionReport[];
}

/**
 * Pass/fail thresholds. Overridable via CLI flags but the defaults are what
 * PR reviewers see — regressions below these should get pushback.
 */
interface Thresholds {
  min_mean_precision: number;
  min_mean_recall: number;
  min_mean_verifiability_fuzz: number;
  min_mean_verifiability_substring_hit_rate: number;
}
const DEFAULT_THRESHOLDS: Thresholds = {
  min_mean_precision: 0.5,
  min_mean_recall: 0.7,
  min_mean_verifiability_fuzz: 85,
  min_mean_verifiability_substring_hit_rate: 0.85,
};

/**
 * "Smoke" IDs — a representative 3-question subset covering a temporal
 * filter, a customer-tier filter, and a multi-doc aggregation. Chosen so a
 * regression in any of the three big code paths (filter step, rescope step,
 * aggregate step) surfaces in under 3 minutes of real API calls.
 */
const SMOKE_IDS = ["q-001", "q-006", "q-013"];

/* ────────────────────────── argv parsing ────────────────────────── */

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
    else if (a === "--min-precision")
      out.overrides.min_mean_precision = Number(argv[++i]);
    else if (a === "--min-recall")
      out.overrides.min_mean_recall = Number(argv[++i]);
    else if (a === "--min-fuzz")
      out.overrides.min_mean_verifiability_fuzz = Number(argv[++i]);
    else if (a === "--min-substring")
      out.overrides.min_mean_verifiability_substring_hit_rate = Number(argv[++i]);
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
      "  --smoke                    3-question smoke test (fast)",
      "  --question <id>            Run a single question by ID",
      "  --report-md                Also write a Markdown report alongside JSON",
      "  --min-precision <n>        Override precision threshold (default 0.5)",
      "  --min-recall <n>           Override recall threshold (default 0.7)",
      "  --min-fuzz <n>             Override verifiability fuzz threshold (default 85)",
      "  --min-substring <n>        Override substring-hit-rate threshold (default 0.85)",
      "  -h, --help                 Show this help",
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
  const { response } = await ask(q.question);
  const latency = Date.now() - t0;
  const r = response.response;

  const expectedSet = new Set(q.expected_scope_ids);
  const actualSet = new Set(r.scope_of_exploration);
  const truePositives = [...actualSet].filter((id) => expectedSet.has(id)).length;
  const precision = actualSet.size === 0 ? 0 : truePositives / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositives / expectedSet.size;

  const contributing = r.signals.filter((s) => s.signal_type === "signal");
  const signalCount = contributing.length;
  const signalCountOk = signalCount >= q.expected_signal_count_min;

  let fuzzSum = 0;
  let substringHits = 0;
  let judgeReferencePass = 0;
  let judgeQuestionPass = 0;
  let judgeCategoryPass = 0;
  let judgeOverallPass = 0;
  let judgedCount = 0;
  for (const s of contributing) {
    if (s.signal_type !== "signal") continue;
    fuzzSum += s.ref_fuzzy_distance;
    try {
      const body = await loadBody(s.scope_of_signal);
      if (body.toLowerCase().includes(s.reference_text.toLowerCase().slice(0, 60))) {
        substringHits++;
      }
    } catch {
      /* ignore */
    }
    if (s.accuracy_adjudication) {
      judgedCount++;
      if (s.accuracy_adjudication.reference_supports_summary.pass) judgeReferencePass++;
      if (s.accuracy_adjudication.summary_addresses_question.pass) judgeQuestionPass++;
      if (s.accuracy_adjudication.category_is_sensible.pass) judgeCategoryPass++;
      if (s.accuracy_adjudication.overall_pass) judgeOverallPass++;
    }
  }
  const meanFuzz = signalCount > 0 ? fuzzSum / signalCount : 0;
  const substringRate = signalCount > 0 ? substringHits / signalCount : 0;
  const denom = judgedCount || 1;

  const text = r.response_text.toLowerCase();
  const mustMentionHits = q.expected_answer_must_mention.filter((t) =>
    text.includes(t.toLowerCase()),
  ).length;
  const mustNotMentionHits = q.expected_answer_must_not_mention.filter((t) =>
    text.includes(t.toLowerCase()),
  ).length;

  return {
    id: q.id,
    question: q.question,
    precision: round3(precision),
    recall: round3(recall),
    signal_count: signalCount,
    signal_count_ok: signalCountOk,
    verifiability_mean_fuzz: round1(meanFuzz),
    verifiability_substring_hit_rate: round3(substringRate),
    judge_reference_pass_rate: round3(judgeReferencePass / denom),
    judge_question_pass_rate: round3(judgeQuestionPass / denom),
    judge_category_pass_rate: round3(judgeCategoryPass / denom),
    judge_overall_pass_rate: round3(judgeOverallPass / denom),
    must_mention_hits: mustMentionHits,
    must_mention_total: q.expected_answer_must_mention.length,
    must_not_mention_hits: mustNotMentionHits,
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
      // Fall back to first 3 if the SMOKE_IDs aren't in this golden set.
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
      console.error(
        `        precision=${r.precision} recall=${r.recall} signals=${r.signal_count} ` +
          `fuzz=${r.verifiability_mean_fuzz} substr=${r.verifiability_substring_hit_rate} ` +
          `cost=$${r.cost_usd.toFixed(4)} elapsed=${(r.latency_ms / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error(
        `        ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const aggregates = {
    mean_precision: round3(mean(reports.map((r) => r.precision))),
    mean_recall: round3(mean(reports.map((r) => r.recall))),
    mean_verifiability_fuzz: round1(
      mean(reports.map((r) => r.verifiability_mean_fuzz)),
    ),
    mean_verifiability_substring_hit_rate: round3(
      mean(reports.map((r) => r.verifiability_substring_hit_rate)),
    ),
    mean_judge_reference_pass_rate: round3(
      mean(reports.map((r) => r.judge_reference_pass_rate)),
    ),
    mean_judge_question_pass_rate: round3(
      mean(reports.map((r) => r.judge_question_pass_rate)),
    ),
    mean_judge_category_pass_rate: round3(
      mean(reports.map((r) => r.judge_category_pass_rate)),
    ),
    mean_judge_overall_pass_rate: round3(
      mean(reports.map((r) => r.judge_overall_pass_rate)),
    ),
    mean_latency_ms: Math.round(mean(reports.map((r) => r.latency_ms))),
    total_cost_usd: round4(reports.reduce((a, r) => a + r.cost_usd, 0)),
  };

  const failures = evaluateThresholds(aggregates, thresholds);

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
): string[] {
  const failures: string[] = [];
  if (aggregates.mean_precision < t.min_mean_precision) {
    failures.push(
      `mean_precision ${aggregates.mean_precision} < ${t.min_mean_precision}`,
    );
  }
  if (aggregates.mean_recall < t.min_mean_recall) {
    failures.push(
      `mean_recall ${aggregates.mean_recall} < ${t.min_mean_recall}`,
    );
  }
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
  return failures;
}

function renderMarkdown(full: FullReport): string {
  const t = full.thresholds;
  const a = full.aggregates;
  const status = full.passed ? "✅ PASSED" : "❌ FAILED";

  const lines: string[] = [];
  lines.push(`# Aletheia Evals — ${full.ran_at}`);
  lines.push("");
  lines.push(`**Mode**: \`${full.mode}\` · **Questions**: ${full.question_count} · **Status**: ${status}`);
  lines.push("");
  lines.push("## Aggregates");
  lines.push("");
  lines.push("| Metric | Value | Threshold |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Mean precision | ${a.mean_precision} | ≥ ${t.min_mean_precision} |`);
  lines.push(`| Mean recall | ${a.mean_recall} | ≥ ${t.min_mean_recall} |`);
  lines.push(
    `| Mean verifiability (fuzz) | ${a.mean_verifiability_fuzz} | ≥ ${t.min_mean_verifiability_fuzz} |`,
  );
  lines.push(
    `| Mean verifiability (substring) | ${a.mean_verifiability_substring_hit_rate} | ≥ ${t.min_mean_verifiability_substring_hit_rate} |`,
  );
  lines.push(
    `| Judge · reference_supports_summary | ${a.mean_judge_reference_pass_rate} | — |`,
  );
  lines.push(
    `| Judge · summary_addresses_question | ${a.mean_judge_question_pass_rate} | — |`,
  );
  lines.push(
    `| Judge · category_is_sensible | ${a.mean_judge_category_pass_rate} | — |`,
  );
  lines.push(
    `| Judge · overall_pass | ${a.mean_judge_overall_pass_rate} | — |`,
  );
  lines.push(`| Mean latency (ms) | ${a.mean_latency_ms} | — |`);
  lines.push(`| Total cost (USD) | $${a.total_cost_usd.toFixed(4)} | — |`);
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
    "| ID | Precision | Recall | Signals | Fuzz | Substr | Cost | Latency (s) |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of full.per_question) {
    lines.push(
      `| ${r.id} | ${r.precision} | ${r.recall} | ${r.signal_count} | ${r.verifiability_mean_fuzz} | ${r.verifiability_substring_hit_rate} | $${r.cost_usd.toFixed(4)} | ${(r.latency_ms / 1000).toFixed(1)} |`,
    );
  }
  lines.push("");
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
