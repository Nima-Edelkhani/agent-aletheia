import { describe, it, expect } from "vitest";
import {
  toIsoDate,
  normalizeTimeWindow,
  applyTimeWindow,
  formatWindow,
} from "../src/core/time-window";
import type { DocMeta } from "../src/core/types";

/**
 * These guard the deterministic date-window enforcement that backs the
 * orchestrator's filter step — the logic that prevents a stale document from
 * being returned for a time-scoped question. Pure functions, no LLM, CI-gated.
 */

function doc(id: string, date?: unknown): DocMeta {
  return { id, metadata: date === undefined ? {} : { date } };
}

describe("toIsoDate", () => {
  it("accepts a bare ISO date", () => {
    expect(toIsoDate("2026-06-12")).toBe("2026-06-12");
  });

  it("truncates a datetime to the date head", () => {
    expect(toIsoDate("2026-06-12T09:30:00Z")).toBe("2026-06-12");
  });

  it("rejects non-ISO shapes", () => {
    expect(toIsoDate("June 12, 2026")).toBeNull();
    expect(toIsoDate("2026/06/12")).toBeNull();
    expect(toIsoDate("2026-6-1")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(20260612)).toBeNull();
    expect(toIsoDate({})).toBeNull();
  });
});

describe("normalizeTimeWindow", () => {
  it("passes through a fully-valid window", () => {
    expect(normalizeTimeWindow({ start: "2026-05-01", end: "2026-06-30" })).toEqual({
      start: "2026-05-01",
      end: "2026-06-30",
    });
  });

  it("keeps a valid bound and nulls an invalid one (open-ended)", () => {
    expect(normalizeTimeWindow({ start: "2026-05-01", end: "bogus" })).toEqual({
      start: "2026-05-01",
      end: null,
    });
    expect(normalizeTimeWindow({ start: null, end: "2026-06-30" })).toEqual({
      start: null,
      end: "2026-06-30",
    });
  });

  it("collapses to null when neither bound is a valid date", () => {
    expect(normalizeTimeWindow({ start: null, end: null })).toBeNull();
    expect(normalizeTimeWindow({ start: "nope", end: "nope" })).toBeNull();
  });

  it("returns null for a null/garbage input", () => {
    expect(normalizeTimeWindow(null)).toBeNull();
  });
});

describe("applyTimeWindow", () => {
  const metadata: DocMeta[] = [
    doc("apr", "2026-04-15"),
    doc("may", "2026-05-07"),
    doc("jun", "2026-06-12"),
    doc("aug", "2026-08-20"),
  ];
  const ids = metadata.map((m) => m.id);

  it("is a no-op passthrough when the window is null", () => {
    const { scope, excluded } = applyTimeWindow(ids, metadata, null);
    expect(scope).toEqual(ids);
    expect(excluded).toEqual([]);
  });

  it("keeps only docs inside an inclusive [start, end] window", () => {
    // May–June window: boundaries are inclusive.
    const { scope, excluded } = applyTimeWindow(ids, metadata, {
      start: "2026-05-01",
      end: "2026-06-30",
    });
    expect(scope).toEqual(["may", "jun"]);
    expect(excluded).toEqual(["apr", "aug"]);
  });

  it("treats both bounds as inclusive on the exact date", () => {
    const { scope } = applyTimeWindow(ids, metadata, {
      start: "2026-05-07",
      end: "2026-06-12",
    });
    expect(scope).toEqual(["may", "jun"]);
  });

  it("excludes everything when no doc falls in the window (the original bug)", () => {
    // "Last 2 months" as of 2026-08-27 → nothing on/after 2026-06-27 except aug,
    // but here we assert the empty case with a July window that contains no docs.
    const { scope, excluded } = applyTimeWindow(ids, metadata, {
      start: "2026-07-01",
      end: "2026-07-31",
    });
    expect(scope).toEqual([]);
    expect(excluded).toEqual(ids);
  });

  it("honors an open-ended start (on or before end)", () => {
    const { scope } = applyTimeWindow(ids, metadata, { start: null, end: "2026-05-31" });
    expect(scope).toEqual(["apr", "may"]);
  });

  it("honors an open-ended end (on or after start)", () => {
    const { scope } = applyTimeWindow(ids, metadata, { start: "2026-06-01", end: null });
    expect(scope).toEqual(["jun", "aug"]);
  });

  it("drops docs with a missing or unparseable date whenever a window is active", () => {
    const meta = [doc("good", "2026-05-10"), doc("nodate"), doc("baddate", "May 2026")];
    const { scope, excluded } = applyTimeWindow(
      ["good", "nodate", "baddate"],
      meta,
      { start: "2026-05-01", end: "2026-05-31" },
    );
    expect(scope).toEqual(["good"]);
    expect(excluded).toEqual(["nodate", "baddate"]);
  });

  it("only considers candidate ids, not the whole corpus", () => {
    // "may" is in-window but not a candidate, so it must not appear in scope.
    const { scope } = applyTimeWindow(["apr", "jun"], metadata, {
      start: "2026-05-01",
      end: "2026-06-30",
    });
    expect(scope).toEqual(["jun"]);
  });
});

describe("formatWindow", () => {
  it("labels a closed window", () => {
    expect(formatWindow({ start: "2026-05-01", end: "2026-06-30" })).toBe(
      "2026-05-01 to 2026-06-30",
    );
  });
  it("labels open-ended bounds", () => {
    expect(formatWindow({ start: "2026-05-01", end: null })).toBe("on or after 2026-05-01");
    expect(formatWindow({ start: null, end: "2026-06-30" })).toBe("on or before 2026-06-30");
  });
  it("labels a null window as any date", () => {
    expect(formatWindow(null)).toBe("any date");
    expect(formatWindow({ start: null, end: null })).toBe("any date");
  });
});
