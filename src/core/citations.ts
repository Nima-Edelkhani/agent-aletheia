/**
 * Rewrites the aggregator's inline `[s1]`, `[s2]`, `[s3]` citation markers
 * into markdown links `[s1](#signal-1)` so a markdown renderer emits <a>
 * nodes that a component override can render as clickable chips.
 *
 * Handles chained markers `[s1][s3]` and preserves any surrounding text.
 * Case-sensitive: `[S1]` is intentionally NOT matched — the aggregator's
 * contract requires lowercase `s`.
 */
export function citationsToMarkdownLinks(text: string): string {
  return text.replace(/\[s(\d+)\]/g, (_m, n) => `[s${n}](#signal-${n})`);
}

/**
 * Extracts the list of signal indices referenced in a response text.
 * Deduplicated, preserves first-appearance order. Useful for validation
 * (did the aggregator cite any indices outside 1..N?).
 */
export function extractCitedIndices(text: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const [, n] of text.matchAll(/\[s(\d+)\]/g)) {
    const idx = Number(n);
    if (!seen.has(idx)) {
      seen.add(idx);
      order.push(idx);
    }
  }
  return order;
}
