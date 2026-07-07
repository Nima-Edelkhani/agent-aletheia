#!/usr/bin/env tsx
import "dotenv/config";

// Ctrl+C: exit immediately even if pending fetches to Anthropic haven't
// resolved. Without this handler Node waits for the event loop to drain,
// and in-flight SDK requests don't observe SIGINT — the process appears
// stuck at the terminal for tens of seconds.
process.on("SIGINT", () => {
  process.stderr.write("\nInterrupted.\n");
  // eslint-disable-next-line n/no-process-exit
  process.exit(130);
});
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { listMetadata } from "../core/knowledge-base";
import { ask } from "../core/orchestrator";
import type {
  AccuracyAdjudication,
  AletheiaResponse,
  PayloadFormat,
  ProgressEvent,
  SignalSignal,
} from "../core/types";
import type { OrchestratorTrace } from "../core/orchestrator";

const program = new Command();

program
  .name("aletheia")
  .description("Verifiable knowledge-base explorer")
  .version("0.1.0");

program
  .command("ask")
  .description("Ask a question of the knowledge base")
  .argument("<question>", "The question to answer")
  .option("--out <path>", "Write full response JSON to this file")
  .option("--scope", "List every doc ID in scope_of_exploration (default: count only)")
  .option(
    "--extract <schemaOrPath>",
    "Optional JSON Schema for typed extraction. Accepts either a file path or an inline JSON string starting with '{'. When set, sub-agents also fill a typed `payload` per signal.",
  )
  .option("--trace", "Also print the orchestrator trace")
  .option(
    "--show-dropped",
    "Also render cards for signals that failed the accuracy filter (hidden by default; the count is always shown)",
  )
  .option(
    "--debug",
    "Print the entire AletheiaResponse (question + response body + all signals) and trace as JSON to stdout, in addition to the pretty summary",
  )
  .action(
    async (
      question: string,
      opts: {
        out?: string;
        scope?: boolean;
        extract?: string;
        trace?: boolean;
        showDropped?: boolean;
        debug?: boolean;
      },
    ) => {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error("ANTHROPIC_API_KEY is not set. Create .env from .env.example.");
        process.exit(1);
      }

      let specifiedFindingFormat: PayloadFormat | undefined;
      if (opts.extract) {
        specifiedFindingFormat = await loadSchemaArg(opts.extract);
      }

      printBanner();

      const t0 = Date.now();
      const { response, trace } = await ask(
        question,
        (e) => printProgress(e, t0),
        { specifiedFindingFormat },
      );
      const elapsed = Date.now() - t0;
      // Clear the progress area with a blank line before the final render.
      console.error("");

      renderResponse(response, trace, {
        scope: opts.scope,
        showDropped: opts.showDropped || opts.debug,
      });

      if (opts.debug) {
        console.error(c.dim("\n[debug] raw response + trace:"));
        console.log(JSON.stringify({ response, trace }, null, 2));
      } else if (opts.trace) {
        console.error(c.dim("\n[trace]"));
        console.error(JSON.stringify(trace, null, 2));
      }

      if (opts.out) {
        const outPath = resolve(process.cwd(), opts.out);
        await mkdir(resolve(outPath, ".."), { recursive: true });
        await writeFile(outPath, JSON.stringify({ response, trace }, null, 2), "utf8");
        console.error(c.dim(`Wrote ${outPath}`));
      }
    },
  );

program
  .command("list-docs")
  .description("List all knowledge-base document metadata")
  .action(async () => {
    printBanner();
    const md = await listMetadata();
    console.log(JSON.stringify(md, null, 2));
    console.error(`\n[aletheia] ${md.length} document(s).`);
  });

program
  .command("evals")
  .description("Run the golden-set evaluation harness")
  .action(async () => {
    printBanner();
    const mod = await import("../../evals/run-evals");
    await mod.default();
  });

/* ─────────────────────────── helpers ─────────────────────────── */

async function loadSchemaArg(arg: string): Promise<PayloadFormat> {
  const trimmed = arg.trim();
  const raw = trimmed.startsWith("{")
    ? trimmed
    : await readFile(resolve(process.cwd(), trimmed), "utf8");
  try {
    return JSON.parse(raw) as PayloadFormat;
  } catch (e) {
    throw new Error(
      `--extract must be valid JSON (path or inline). Parse error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/* ────────────────────────────── progress ────────────────────────────── */

function printProgress(e: ProgressEvent, t0: number): void {
  const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(5, " ");
  const stamp = c.dim(`[${t}s]`);
  switch (e.type) {
    case "started":
      console.error(
        `${stamp} ${c.bold("▶")} Question received. Knowledge base has ${c.cyan(String(e.kb_size))} doc(s).`,
      );
      break;
    case "filter_started":
      console.error(`${stamp} ${c.dim("┈")} Step 1: filtering knowledge base by metadata…`);
      break;
    case "filter_done":
      console.error(
        `${stamp} ${c.green("✓")} Step 1: ${c.bold(String(e.scope_of_exploration.length))} doc(s) in scope ${c.dim(`(orchestrator +$${e.cost.toFixed(4)})`)}`,
      );
      break;
    case "rescope_started":
      console.error(`${stamp} ${c.dim("┈")} Step 2/3: rescoping question + composing payload_format…`);
      break;
    case "rescope_done":
      console.error(
        `${stamp} ${c.green("✓")} Step 2/3: rescoped to ${c.dim(`"${e.question_rescoped.slice(0, 60)}${e.question_rescoped.length > 60 ? "…" : ""}"`)} ${c.dim(`(+$${e.cost.toFixed(4)})`)}`,
      );
      break;
    case "fanout_started":
      console.error(
        `${stamp} ${c.dim("┈")} Step 4: spawning ${c.bold(String(e.doc_ids.length))} sub-agent(s)…`,
      );
      break;
    case "subagent_started":
      console.error(`${stamp} ${c.dim("  →")} sub-agent started: ${c.cyan(e.doc_id)}`);
      break;
    case "subagent_done":
      if (e.error) {
        console.error(
          `${stamp} ${c.red("  ✗")} sub-agent error   : ${c.cyan(e.doc_id)} ${c.red(e.error)}`,
        );
      } else if (e.no_signal) {
        console.error(
          `${stamp} ${c.dim("  ○")} sub-agent no-signal: ${c.cyan(e.doc_id)} ${c.dim(`(${(e.duration_ms / 1000).toFixed(1)}s)`)}`,
        );
      } else {
        console.error(
          `${stamp} ${c.green("  ✓")} sub-agent emitted : ${c.cyan(e.doc_id)} · ${e.signal_count} signal(s) ${c.dim(`(${(e.duration_ms / 1000).toFixed(1)}s, +$${e.cost.toFixed(4)})`)}`,
        );
      }
      break;
    case "fanout_done":
      if (e.timed_out_hard)
        console.error(`${stamp} ${c.red("⚠")} Step 4: hard timeout reached.`);
      else if (e.timed_out_soft)
        console.error(`${stamp} ${c.dim("⚠")} Step 4: soft timeout reached (≥90% done).`);
      else console.error(`${stamp} ${c.green("✓")} Step 4: all sub-agents complete.`);
      break;
    case "signal_filter_done":
      console.error(
        `${stamp} ${c.green("✓")} Step 6: signal filter — kept ${c.bold(String(e.kept))}, dropped ${e.dropped}.`,
      );
      break;
    case "aggregate_started":
      console.error(`${stamp} ${c.dim("┈")} Step 7: aggregating signals into final answer…`);
      break;
    case "aggregate_done":
      console.error(
        `${stamp} ${c.green("✓")} Step 7: answer composed ${c.dim(`(+$${e.cost.toFixed(4)})`)}.`,
      );
      break;
    case "finished":
      console.error(
        `${stamp} ${c.bold("■")} Finished in ${(e.delay_ms / 1000).toFixed(1)}s, total cost ≈ $${e.total_cost.toFixed(4)}.`,
      );
      break;
  }
}

/* ────────────────────────────── rendering ────────────────────────────── */

const WIDTH = 78;

const BANNER_LINES = [
  " █████╗ ██╗     ███████╗████████╗██╗  ██╗███████╗██╗ █████╗ ",
  "██╔══██╗██║     ██╔════╝╚══██╔══╝██║  ██║██╔════╝██║██╔══██╗",
  "███████║██║     █████╗     ██║   ███████║█████╗  ██║███████║",
  "██╔══██║██║     ██╔══╝     ██║   ██╔══██║██╔══╝  ██║██╔══██║",
  "██║  ██║███████╗███████╗   ██║   ██║  ██║███████╗██║██║  ██║",
  "╚═╝  ╚═╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝",
];

function printBanner(): void {
  // Matches the web masthead: raw pixel-block ASCII art, no frame, no
  // caption. Bold white/black via terminal default foreground so it flips
  // with the terminal's own theme — no coloured hue.
  console.error("");
  for (const l of BANNER_LINES) {
    console.error(c.bold(l));
  }
  console.error("");
}

// Minimal ANSI helpers (no external dep). Auto-disable if not a TTY.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap_ = (open: string, close: string) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;
/**
 * Palette chosen to work on BOTH light and dark terminals without relying on
 * any specific foreground/background pair. Bright yellow (`93`) is banned —
 * it's invisible on white terminals. We express emphasis via bold, underline,
 * or reverse-video (`7`) which always contrasts against the terminal's own
 * background, whatever it is.
 */
const c = {
  bold: wrap_("1", "22"),
  dim: wrap_("2", "22"),
  grey: wrap_("90", "39"), // bright-black, reads as muted on both light & dark
  cyan: wrap_("36", "39"), // doc IDs — safe on both backgrounds
  green: wrap_("32", "39"),
  red: wrap_("31", "39"),
  underline: wrap_("4", "24"),
  inverse: wrap_("7", "27"), // reverse video — highest-contrast chip on any bg
  // Quote highlight: bold + underline (no color) — always visible.
  emph: wrap_("1;4", "22;24"),
  // Citation chip: reverse video + bold — always a distinct chip.
  chip: wrap_("1;7", "22;27"),
};

/* ─────────────────────── high-level layout ─────────────────────── */

const INNER = WIDTH - 4; // content width inside a card (│ · … · │)

function renderResponse(
  r: AletheiaResponse,
  trace: OrchestratorTrace,
  opts: { scope?: boolean; showDropped?: boolean },
): void {
  const body = r.response;
  const contributing = body.signals.filter(
    (s): s is SignalSignal => s.signal_type === "signal",
  );
  const noSignal = body.signals.filter((s) => s.signal_type === "no-signal");
  const dropped = trace.dropped_signals.filter(
    (d) => d.signal.signal_type === "signal",
  );
  const thresholds = trace.thresholds_applied;

  const out: string[] = [];

  // ── § 01 QUESTION ────────────────────────────────────────────────
  out.push("");
  out.push(marker("01", "Question"));
  out.push("");
  wrap(r.question, WIDTH).forEach((l) => out.push(l));
  out.push("");
  const scopeLine = `${body.scope_of_exploration.length} document(s) considered relevant and examined`;
  if (opts.scope) {
    out.push(c.dim(scopeLine + ":"));
    body.scope_of_exploration.forEach((id) =>
      out.push(c.dim("  · ") + c.cyan(id)),
    );
  } else {
    out.push(c.dim(scopeLine + "  (--scope to list)"));
  }

  // ── § 02 ANSWER ──────────────────────────────────────────────────
  out.push("");
  out.push(marker("02", "Answer"));
  out.push("");
  out.push(renderAnswerMarkdown(body.response_text));
  out.push("");
  out.push(
    c.dim("Based on ") +
      c.bold(String(contributing.length)) +
      c.dim(` signal${contributing.length === 1 ? "" : "s"}`) +
      (dropped.length
        ? c.dim(" · ") + c.red(`${dropped.length} dropped`)
        : "") +
      (noSignal.length
        ? c.dim(" · ") + c.dim(`${noSignal.length} no-signal`)
        : ""),
  );
  if (
    body.filtering_reasoning &&
    body.filtering_reasoning !== "No signals were filtered out."
  ) {
    out.push("");
    wrap(body.filtering_reasoning, WIDTH).forEach((l) =>
      out.push(c.dim("⚠ ") + c.dim(l)),
    );
  }

  // ── § 03 SIGNALS ─────────────────────────────────────────────────
  const showDropped = !!opts.showDropped;
  const anySignalCards = contributing.length > 0 || (showDropped && dropped.length > 0);
  if (anySignalCards) {
    out.push("");
    out.push(marker("03", "Signals"));
    contributing.forEach((s, i) => {
      out.push("");
      out.push(...renderSignalCard(s, i + 1, thresholds));
    });
    if (showDropped) {
      dropped.forEach((entry, i) => {
        if (entry.signal.signal_type !== "signal") return;
        out.push("");
        out.push(
          ...renderSignalCard(
            entry.signal,
            contributing.length + i + 1,
            thresholds,
            entry.reason,
          ),
        );
      });
    } else if (dropped.length > 0) {
      out.push("");
      out.push(
        c.dim(
          `  ${dropped.length} dropped signal(s) hidden — pass --show-dropped to render them.`,
        ),
      );
    }
  }

  // ── § 04 PERFORMANCE ─────────────────────────────────────────────
  out.push("");
  out.push(marker("04", "Performance"));
  out.push("");
  out.push(
    "  " +
      c.dim("cost     ") +
      c.bold(`$${body.cost_estimate.toFixed(4)}`),
  );
  out.push(
    "  " +
      c.dim("elapsed  ") +
      c.bold(`${(body.delay / 1000).toFixed(1)}s`),
  );
  out.push(
    "  " +
      c.dim("signals  ") +
      c.green(`${contributing.length} kept`) +
      c.dim(" · ") +
      (dropped.length > 0
        ? c.red(`${dropped.length} dropped`)
        : c.dim("0 dropped")) +
      c.dim(" · ") +
      c.dim(`${noSignal.length} no-signal`),
  );
  out.push("");

  console.log(out.join("\n"));
}

/* ─────────────────────── section marker ─────────────────────── */

/** Mirrors the UI's brutal [NN] LABEL ─── rule. */
function marker(n: string, label: string): string {
  const nBlock = c.inverse(` ${n} `);
  const lbl = c.bold(label.toUpperCase());
  const shown = ` ${n} `.length + 1 + label.length + 3;
  const rule = c.dim(" " + "─".repeat(Math.max(0, WIDTH - shown)));
  return nBlock + " " + lbl + " " + rule;
}

/* ─────────────────────── signal card ─────────────────────── */

function renderSignalCard(
  s: SignalSignal,
  index: number,
  thresholds: OrchestratorTrace["thresholds_applied"],
  droppedReason?: string,
): string[] {
  const isDropped = !!droppedReason;
  const fuzzOk = s.ref_fuzzy_distance >= thresholds.ref_fuzzy_distance_cutoff;
  const confOk = s.confidence >= thresholds.confidence_cutoff;
  const borderColor = isDropped ? c.red : (x: string) => x;
  const lines: string[] = [];

  // ── HEADER (top border) ──
  const idLabel = `SIGNAL ${index}`;
  const doc = s.scope_of_signal;
  const rightBadge = isDropped
    ? c.red("dropped ⊘")
    : s.accuracy_pass
    ? c.green("accuracy ✓")
    : c.red("accuracy ✗");
  lines.push(headerBorder(idLabel, doc, rightBadge, borderColor));

  // Optional red "Dropped from answer · reason" strip
  if (isDropped) {
    lines.push(row(c.red(`Dropped from answer · ${droppedReason}`), borderColor));
    lines.push(spacer(borderColor));
  } else {
    lines.push(spacer(borderColor));
  }

  // ── RESCOPED QUESTION ──
  lines.push(row(label("Rescoped question"), borderColor));
  wrapAnsi(c.dim(s.question_rescoped), INNER).forEach((l) =>
    lines.push(row(l, borderColor)),
  );
  lines.push(spacer(borderColor));

  // ── QUOTE ──
  lines.push(labelWithTrailing(
    "Quote",
    meter("fuzz", s.ref_fuzzy_distance, 100, thresholds.ref_fuzzy_distance_cutoff, !fuzzOk),
    borderColor,
  ));
  const quoteLines = renderQuoteText(
    s.before_reference_text,
    s.reference_text,
    s.after_reference_text,
    INNER,
  );
  quoteLines.forEach((l) => lines.push(row(l, borderColor)));
  lines.push(spacer(borderColor));

  // ── FINDING ──
  lines.push(
    labelWithTrailing(
      "Finding",
      meter(
        "confidence",
        Math.round(s.confidence * 100),
        100,
        Math.round(thresholds.confidence_cutoff * 100),
        !confOk,
      ),
      borderColor,
    ),
  );
  wrapAnsi(s.finding_summary, INNER).forEach((l) =>
    lines.push(row(l, borderColor)),
  );
  if (s.finding_category) {
    lines.push(row(c.dim("category: ") + c.cyan(s.finding_category), borderColor));
  }
  lines.push(spacer(borderColor));

  // ── EXTRACTION (only when specified_finding_format was set) ──
  if (s.payload_format !== null && Object.keys(s.payload).length > 0) {
    lines.push(row(label("Extraction"), borderColor));
    for (const [k, v] of Object.entries(s.payload)) {
      lines.push(row(`  ${c.cyan(k)}: ${formatPayloadValue(v)}`, borderColor));
    }
    lines.push(spacer(borderColor));
  }

  // ── ACCURACY · JUDGE (3-check drill) ──
  if (s.accuracy_adjudication) {
    lines.push(
      labelWithTrailing(
        "Accuracy · judge",
        adjudicationTally(s.accuracy_adjudication),
        borderColor,
      ),
    );
    renderAdjudication(s.accuracy_adjudication, INNER).forEach((l) =>
      lines.push(row(l, borderColor)),
    );
    lines.push(spacer(borderColor));
  }

  // ── STATS ──
  lines.push(row(label("Stats"), borderColor));
  const statsLine =
    c.dim("model: ") +
    s.model +
    c.dim("  cost: ") +
    `$${s.cost_estimate.toFixed(5)}` +
    c.dim("  id: ") +
    s.id.slice(0, 8) +
    c.dim("…");
  lines.push(row(statsLine, borderColor));

  // ── BOTTOM BORDER ──
  lines.push(borderColor("└" + "─".repeat(WIDTH - 2) + "┘"));

  return lines;
}

/* ─── card helpers ─── */

function label(text: string): string {
  return c.dim(text.toUpperCase());
}

// ANSI "full reset" — prevents color bleed from an unclosed escape inside
// `content` (common with wrapped colored text) leaking into the trailing
// border character.
const RESET = "\x1b[0m";

function row(content: string, border: (s: string) => string): string {
  return (
    border("│") +
    " " +
    padRight(content, INNER) +
    RESET +
    " " +
    border("│")
  );
}

function spacer(border: (s: string) => string): string {
  return border("│") + " ".repeat(WIDTH - 2) + border("│");
}

function labelWithTrailing(
  labelText: string,
  trailing: string,
  border: (s: string) => string,
): string {
  const l = label(labelText);
  const gap = INNER - visLen(l) - visLen(trailing);
  return (
    border("│") +
    " " +
    l +
    " ".repeat(Math.max(1, gap)) +
    trailing +
    RESET +
    " " +
    border("│")
  );
}

function headerBorder(
  idLabel: string,
  doc: string,
  badge: string,
  border: (s: string) => string,
): string {
  // ┌── SIGNAL 1 · <doc> ─── <badge> ──┐
  // Total width = ┌ + ─ + left + filler + right + ─ + ┐ = 4 fixed chars
  // + variable content. filler must make the sum equal WIDTH exactly.
  const left = " " + c.bold(idLabel) + c.dim(" · ") + c.cyan(doc) + " ";
  const right = " " + badge + RESET + " ";
  const filler = Math.max(
    2,
    WIDTH - 4 - visLen(left) - visLen(right),
  );
  return (
    border("┌") +
    border("─") +
    left +
    border("─".repeat(filler)) +
    right +
    border("─") +
    border("┐")
  );
}

/* ─── quote text (with citation-aware coloring) ─── */

function renderQuoteText(
  before: string,
  ref: string,
  after: string,
  width: number,
): string[] {
  // Collapse all internal whitespace to single spaces so wrapping produces
  // clean single-line rows that fit inside the card's │ … │ frame. The raw
  // before/after strings often contain embedded newlines from the source
  // transcript; those must not leak into rendered lines or the box breaks.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  // We use tokens for grey (before/after) and underline (ref) to satisfy:
  //   before + after: dim grey
  //   ref: white + underline (even across multi-line wraps)
  const GREY_OPEN = "\x1b[90m";
  const GREY_CLOSE = "\x1b[39m";
  const UL_OPEN = "\x1b[4m";
  const UL_CLOSE = "\x1b[24m";

  const composed =
    (before ? GREY_OPEN + norm(before) + GREY_CLOSE + " " : "") +
    UL_OPEN + norm(ref) + UL_CLOSE +
    (after ? " " + GREY_OPEN + norm(after) + GREY_CLOSE : "");

  const raw = wrapAnsi(composed, width);

  // Post-process: keep grey / underline state alive across wrapped lines
  // by closing at end of each line and re-opening at the start of the next.
  // This is what wrapAnsi alone can't do — its split at whitespace boundaries
  // orphans the open code inherited from the previous line.
  const OPENERS = { grey: GREY_OPEN, ul: UL_OPEN };
  const CLOSERS = { grey: GREY_CLOSE, ul: UL_CLOSE };
  const codeRe = /\x1b\[[0-9;]*m/g;

  const out: string[] = [];
  let carry: keyof typeof OPENERS | null = null;

  for (const line of raw) {
    const prefixed = carry ? OPENERS[carry] + line : line;

    // Walk every SGR code to determine what state the line ends in.
    let state: keyof typeof OPENERS | null = carry;
    let m: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((m = codeRe.exec(prefixed)) !== null) {
      const code = m[0];
      if (code === GREY_OPEN) state = "grey";
      else if (code === UL_OPEN) state = "ul";
      else if (code === GREY_CLOSE && state === "grey") state = null;
      else if (code === UL_CLOSE && state === "ul") state = null;
    }

    const closed = state ? prefixed + CLOSERS[state] : prefixed;
    carry = state;
    out.push(closed);
  }
  return out;
}

/* ─── payload value formatter ─── */

function formatPayloadValue(v: unknown): string {
  if (v === null) return c.dim("null");
  if (typeof v === "boolean") return v ? c.green("true") : c.red("false");
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `"${v}"`;
  return JSON.stringify(v);
}

/* ─── progress meter (fuzz / confidence) ─── */

function meter(
  name: string,
  value: number,
  max: number,
  cutoff: number,
  belowCutoff: boolean,
): string {
  const barWidth = 8;
  const filled = Math.round((value / max) * barWidth);
  const empty = barWidth - filled;
  const bar =
    (belowCutoff
      ? c.red
      : value / max >= 0.85
      ? c.green
      : value / max >= 0.6
      ? c.dim
      : c.red)("█".repeat(filled)) + c.dim("░".repeat(empty));
  const num = `${value}/${max}`;
  const cutoffTag = belowCutoff ? c.red(`  < ${cutoff}`) : "";
  return (
    c.dim(name + "  ") +
    bar +
    "  " +
    (belowCutoff ? c.red(num) : num) +
    cutoffTag
  );
}

/* ─── accuracy adjudication ─── */

function adjudicationTally(a: AccuracyAdjudication): string {
  const passCount = [
    a.reference_supports_summary.pass,
    a.summary_addresses_question.pass,
    a.category_is_sensible.pass,
  ].filter(Boolean).length;
  const tally = `${passCount}/3`;
  return c.dim(tally);
}

function renderAdjudication(
  a: AccuracyAdjudication,
  width: number,
): string[] {
  const out: string[] = [];
  const checks = [
    { label: "reference supports summary", check: a.reference_supports_summary },
    { label: "summary addresses question", check: a.summary_addresses_question },
    { label: "category is sensible", check: a.category_is_sensible },
  ];
  for (const { label: name, check } of checks) {
    const icon = check.pass ? c.green("✓") : c.red("✗");
    out.push(`  ${icon} ${c.bold(name)}`);
    wrapAnsi(c.dim(check.reason || "(no reason provided)"), width - 4).forEach(
      (l) => out.push("    " + l),
    );
  }
  return out;
}

/* ─── citation highlighting in the answer ─── */

/**
 * Wraps [s1], [s2] tokens as reverse-video chips. Reverse video always
 * contrasts against the terminal's own background so it works on both
 * light and dark themes.
 */
function highlightCitations(text: string): string {
  return text.replace(/\[s(\d+)\]/g, (_m, n) => c.chip(` s${n} `));
}

/* ─── Markdown rendering for the answer body ─────────────────────── */

// Configure marked-terminal with a color-scheme-agnostic palette: no
// yellows, no blues; just bold / underline / dim / bright-black. That way
// the output is legible on both dark and light terminals.
marked.use(
  markedTerminal({
    // Palette
    firstHeading: (t: string) => c.bold(String(t).toUpperCase()) + "\n",
    heading: (t: string) => c.bold(String(t).toUpperCase()) + "\n",
    blockquote: (t: string) => c.dim("│ " + String(t).trim()),
    hr: () => c.dim("─".repeat(WIDTH)) + "\n",
    listitem: (t: string) => "  " + String(t),
    strong: (t: string) => c.bold(String(t)),
    em: (t: string) => c.underline(String(t)),
    del: (t: string) => c.dim(String(t)),
    code: (t: string) => c.dim(String(t)),
    codespan: (t: string) => c.dim("`" + String(t) + "`"),
    link: (t: string) => c.underline(String(t)),
    href: (t: string) => c.dim(String(t)),
    // Formatting
    width: WIDTH,
    reflowText: true,
    tab: 2,
    unescape: true,
    emoji: false,
    tableOptions: {
      chars: {
        top: "─", "top-mid": "─", "top-left": "┌", "top-right": "┐",
        bottom: "─", "bottom-mid": "─", "bottom-left": "└", "bottom-right": "┘",
        left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼",
        right: "│", "right-mid": "┤", middle: "│",
      },
    },
  } as never),
);

/**
 * Render answer text as a Markdown block (headings, bold, tables, lists),
 * then post-process to highlight [sN] citation tokens as reverse-video chips.
 * `marked-terminal` handles table alignment, list bullets, headings, etc.
 */
function renderAnswerMarkdown(text: string): string {
  const rendered = String(marked.parse(text));
  // Strip a trailing newline for tidy spacing above the "Based on…" line.
  const trimmed = rendered.replace(/\n+$/g, "");
  return highlightCitations(trimmed);
}

/* ─── string-width helpers ─── */

const ansiRe = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
  return s.replace(ansiRe, "").length;
}
function padRight(s: string, width: number): string {
  const len = visLen(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

function wrap(text: string, width: number): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  paras.forEach((para, i) => {
    if (i > 0) out.push("");
    para.split("\n").forEach((chunk) => {
      const words = chunk.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        if ((line + " " + w).trim().length > width) {
          out.push(line);
          line = w;
        } else {
          line = (line ? line + " " : "") + w;
        }
      }
      if (line) out.push(line);
    });
  });
  return out;
}

/**
 * Wrap text that contains ANSI escapes, measuring visible width only.
 * Collapses ALL whitespace (including newlines) to single spaces so that
 * the returned lines are guaranteed to be free of embedded newlines —
 * critical for card-framed output where each line lives inside `│ … │`.
 */
function wrapAnsi(text: string, width: number): string[] {
  const ansiRe = /\x1b\[[0-9;]*m/g;
  const visLen = (s: string) => s.replace(ansiRe, "").length;
  const tokens: string[] = [];
  // Split into word / whitespace tokens BUT normalize any whitespace run
  // (including newlines) to a single space token. This is the fix for the
  // "quote text contains newlines and breaks the box frame" bug.
  let buf = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      // Emit a single-space token only if the previous token wasn't already one.
      if (tokens.length && tokens[tokens.length - 1] !== " ") {
        tokens.push(" ");
      }
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  const out: string[] = [];
  let line = "";
  for (const t of tokens) {
    if (t === " ") {
      if (line) line += " ";
      continue;
    }
    if (visLen(line + t) > width && line.trim()) {
      out.push(line.trimEnd());
      line = t;
    } else {
      line += t;
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}

await program.parseAsync(process.argv);
