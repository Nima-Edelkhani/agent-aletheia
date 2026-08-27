import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Loads and renders the accuracy judge's few-shot examples from
 * `config/judge-fewshots.json` into a prompt fragment.
 *
 * The judge (src/core/subagent.ts) runs three independent checks per signal
 * — reference_supports_summary, summary_addresses_question,
 * category_is_sensible. Each check has PASS and FAIL exemplars in the JSON
 * file; this module turns them into the "Few-shot examples" section of the
 * judge system prompt.
 *
 * Kept as a data file (not inline strings) so judge behavior can be tuned
 * without editing TypeScript, and so the same exemplars the judge reads are
 * versioned and reviewable in one place. The rendered string is memoized —
 * the judge prompt is identical for every signal and is prompt-cached.
 */

const DEFAULT_PATH = resolve(process.cwd(), "config/judge-fewshots.json");

export interface JudgeFewShotExample {
  verdict: "pass" | "fail";
  rescoped_question: string;
  reference_text: string;
  before_reference_text?: string;
  after_reference_text?: string;
  finding_summary: string;
  finding_category: string;
  reason: string;
}

export interface JudgeCheckFewShots {
  check: string;
  guidance: string;
  examples: JudgeFewShotExample[];
}

export interface JudgeFewShotFile {
  checks: JudgeCheckFewShots[];
}

let cachedRender: string | null = null;

/**
 * Reads and parses the few-shot file. Exposed (rather than only the rendered
 * string) so tests can assert coverage — e.g. every check has ≥1 pass and ≥1
 * fail example.
 */
export async function loadJudgeFewShots(
  path: string = DEFAULT_PATH,
): Promise<JudgeFewShotFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as JudgeFewShotFile;
  if (!parsed || !Array.isArray(parsed.checks)) {
    throw new Error(`judge few-shots at ${path} missing \`checks\` array`);
  }
  return parsed;
}

/**
 * Renders the few-shots into the prompt fragment appended to the judge system
 * prompt. Returns an empty string (and warns) if the file is missing or
 * malformed, so the judge degrades to its base rules rather than crashing.
 */
export async function renderJudgeFewShots(
  path: string = DEFAULT_PATH,
): Promise<string> {
  if (cachedRender !== null && path === DEFAULT_PATH) return cachedRender;

  let file: JudgeFewShotFile;
  try {
    file = await loadJudgeFewShots(path);
  } catch (err) {
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      console.warn(
        `[judge-fewshots] Could not load ${path} — judge will run with base ` +
          `rules only. Reason: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (path === DEFAULT_PATH) cachedRender = "";
    return "";
  }

  const lines: string[] = [
    "─── Few-shot examples ─────────────────────────────────────────────",
    "",
    "Each example below ISOLATES one check: the target check's verdict is the",
    "teaching point, and the other two checks are held as pass so the verdict",
    "is unambiguous. Apply the same reasoning to the candidate signal.",
  ];

  for (const block of file.checks) {
    lines.push("");
    lines.push(`### Check: ${block.check}`);
    lines.push(block.guidance);
    lines.push("");
    block.examples.forEach((ex, i) => {
      const verdict = ex.verdict.toUpperCase();
      lines.push(`EXAMPLE ${i + 1} — ${block.check}: ${verdict}`);
      lines.push(`  rescoped_question: ${JSON.stringify(ex.rescoped_question)}`);
      if (ex.before_reference_text) {
        lines.push(`  before_reference_text: ${JSON.stringify(ex.before_reference_text)}`);
      }
      lines.push(`  reference_text: ${JSON.stringify(ex.reference_text)}`);
      if (ex.after_reference_text) {
        lines.push(`  after_reference_text: ${JSON.stringify(ex.after_reference_text)}`);
      }
      lines.push(`  finding_summary: ${JSON.stringify(ex.finding_summary)}`);
      lines.push(`  finding_category: ${JSON.stringify(ex.finding_category)}`);
      // Strip a redundant leading "PASS:"/"FAIL:" the author may have put in
      // the reason, so the line doesn't read "PASS — PASS: ...".
      const reason = ex.reason.replace(/^\s*(PASS|FAIL)\s*:\s*/i, "");
      lines.push(`  → ${block.check}: ${verdict} — ${reason}`);
      lines.push("");
    });
  }

  const rendered = lines.join("\n").trimEnd();
  if (path === DEFAULT_PATH) cachedRender = rendered;
  return rendered;
}

/** Test-only: clears the memoized render so a different path can be loaded. */
export function resetJudgeFewShotsCache(): void {
  cachedRender = null;
}
