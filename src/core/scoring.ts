import { distance } from "fastest-levenshtein";
import Ajv from "ajv";
import type { PayloadFormat, SignalSignal } from "./types";

/**
 * Partial-ratio fuzzy match (rapidfuzz-equivalent). Returns a 0–100 score
 * indicating how well `reference` appears as a substring of `body`.
 *
 * Slides a window of length reference.length across body, computing
 * Levenshtein distance for each. Fast-paths on exact substring hits.
 * For very long bodies we step by a fraction of the reference length
 * to keep this tractable.
 */
export function fuzzball(reference: string, body: string): number {
  if (!reference || !body) return 0;
  const r = reference.toLowerCase();
  const b = body.toLowerCase();
  if (r.length > b.length) return fuzzball(body, reference);
  if (b.includes(r)) return 100;

  const winLen = r.length;
  // Step of 1 for short references, larger step for long ones — trades
  // precision for speed but never misses a match by more than `step` chars,
  // which we compensate for with a coarse-then-fine pass.
  const coarseStep = Math.max(1, Math.floor(winLen / 8));
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let i = 0; i <= b.length - winLen; i += coarseStep) {
    const d = distance(r, b.substring(i, i + winLen));
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      if (d === 0) break;
    }
  }

  // Fine pass ±coarseStep around best coarse index.
  if (coarseStep > 1) {
    const lo = Math.max(0, bestIdx - coarseStep);
    const hi = Math.min(b.length - winLen, bestIdx + coarseStep);
    for (let i = lo; i <= hi; i++) {
      const d = distance(r, b.substring(i, i + winLen));
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
  }

  const ratio = 100 * (1 - bestDist / winLen);
  return Math.max(0, Math.min(100, Math.round(ratio)));
}

/**
 * Locates the best match of `reference` in `body` and returns the
 * surrounding context — sentences immediately before and after. Content
 * is extracted from the real body, never from model output, so the
 * before/after fields on a signal are always trustworthy.
 */
export function extractContext(
  reference: string,
  body: string,
  beforeMax = 300,
  afterMax = 300,
): { before: string; after: string; matchStart: number; matchEnd: number } {
  if (!reference || !body) return { before: "", after: "", matchStart: -1, matchEnd: -1 };

  const r = reference.toLowerCase();
  const b = body.toLowerCase();

  let matchStart = b.indexOf(r);
  let matchEnd = matchStart >= 0 ? matchStart + reference.length : -1;

  if (matchStart < 0) {
    // Fuzzy locate — reuse the fuzzball sliding-window logic to find best index.
    const winLen = r.length;
    if (winLen > b.length) {
      return { before: "", after: "", matchStart: -1, matchEnd: -1 };
    }
    const step = Math.max(1, Math.floor(winLen / 8));
    let bestDist = Number.POSITIVE_INFINITY;
    let bestIdx = 0;
    for (let i = 0; i <= b.length - winLen; i += step) {
      const d = distance(r, b.substring(i, i + winLen));
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    matchStart = bestIdx;
    matchEnd = bestIdx + winLen;
  }

  const rawBefore = body.substring(Math.max(0, matchStart - beforeMax), matchStart);
  const rawAfter = body.substring(matchEnd, Math.min(body.length, matchEnd + afterMax));

  return {
    before: trimToSentenceBoundary(rawBefore, "left"),
    after: trimToSentenceBoundary(rawAfter, "right"),
    matchStart,
    matchEnd,
  };
}

/**
 * Trims to a clean sentence/paragraph boundary at the FAR edge only,
 * keeping as much of the extracted window as possible. For side='left'
 * (text before the reference), we search the FIRST ~30% of the window
 * for a boundary and start the snippet there — so we open with a clean
 * sentence but retain everything after it. For side='right' (text after
 * the reference), we search the LAST ~30% and end there. Paragraph
 * boundaries (double newlines) are preferred over sentence boundaries.
 */
function trimToSentenceBoundary(s: string, side: "left" | "right"): string {
  if (!s) return s;
  const searchWindow = Math.floor(s.length * 0.3);

  if (side === "left") {
    // Prefer a paragraph break in the first 30%; else the first sentence break.
    const slice = s.substring(0, searchWindow);
    const para = /\n\s*\n/.exec(slice);
    if (para) {
      return s.substring(para.index + para[0].length).trim();
    }
    const sent = /[.!?]\s+/.exec(slice);
    if (sent) {
      return s.substring(sent.index + sent[0].length).trim();
    }
    return s.trim();
  } else {
    // Prefer a paragraph break in the last 30%; else the last sentence break.
    const start = s.length - searchWindow;
    const slice = s.substring(start);
    const paraMatches = [...slice.matchAll(/\n\s*\n/g)];
    if (paraMatches.length > 0) {
      const last = paraMatches[paraMatches.length - 1];
      return s.substring(0, start + last.index!).trim();
    }
    const sentMatches = [...slice.matchAll(/[.!?]\s+/g)];
    if (sentMatches.length > 0) {
      const last = sentMatches[sentMatches.length - 1];
      return s.substring(0, start + last.index! + last[0].length).trim();
    }
    return s.trim();
  }
}

const ajv = new Ajv({ allErrors: false, strict: false });

/**
 * Cheap deterministic pre-filter. Runs before the LLM judge is invoked so
 * we don't spend money adjudicating signals that would fail on the basics:
 *
 *   - If a `specifiedFindingFormat` was provided, the payload must validate.
 *   - The fuzz score must clear the cutoff (defends against fabricated quotes).
 *
 * Returns `{ pass, reason }`. When `pass` is false, `reason` explains which
 * gate failed and is surfaced in the trace / dropped-signals list.
 */
export function preFilterAccuracy(
  signal: Pick<SignalSignal, "ref_fuzzy_distance" | "payload">,
  payloadFormat: PayloadFormat | null,
  cutoff: number,
): { pass: boolean; reason: string } {
  if (payloadFormat !== null) {
    const schemaOk = validatePayload(signal.payload, payloadFormat);
    if (!schemaOk) {
      return {
        pass: false,
        reason: "payload does not validate against specified_finding_format",
      };
    }
  }
  if (signal.ref_fuzzy_distance < cutoff) {
    return {
      pass: false,
      reason: `ref_fuzzy_distance ${signal.ref_fuzzy_distance} below cutoff ${cutoff} — quote does not appear in source`,
    };
  }
  return { pass: true, reason: "passed pre-filter (schema + fuzz)" };
}

export function validatePayload(payload: unknown, schema: PayloadFormat): boolean {
  if (!schema || Object.keys(schema).length === 0) return true;
  try {
    const validate = ajv.compile(schema);
    return validate(payload) as boolean;
  } catch {
    // Malformed schema — accept payload rather than block indefinitely.
    return true;
  }
}
