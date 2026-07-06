import { describe, it, expect } from "vitest";
import { fuzzball, extractContext, preFilterAccuracy, validatePayload } from "../src/core/scoring.js";

describe("fuzzball", () => {
  it("returns 100 for exact substring match", () => {
    expect(fuzzball("hello world", "well, hello world, how are you?")).toBe(100);
  });

  it("returns high score for near-match with typos", () => {
    const score = fuzzball("hello wrld", "well, hello world, how are you?");
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("returns 0 for completely unrelated strings", () => {
    const score = fuzzball("xyz123", "the quick brown fox");
    expect(score).toBeLessThan(50);
  });

  it("returns 0 for empty inputs", () => {
    expect(fuzzball("", "some body")).toBe(0);
    expect(fuzzball("some", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzball("HELLO WORLD", "hello world here")).toBe(100);
  });
});

describe("extractContext", () => {
  const body = "First sentence. Second sentence here. This is the target quote. And a follow up sentence. Then another one afterwards.";

  it("locates the reference and returns before/after", () => {
    const { before, after, matchStart, matchEnd } = extractContext(
      "This is the target quote.",
      body,
      100,
      100,
    );
    expect(matchStart).toBeGreaterThan(0);
    expect(matchEnd).toBeGreaterThan(matchStart);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });

  it("handles missing reference gracefully (fuzzy locate)", () => {
    const result = extractContext("targt qoute", body, 100, 100);
    expect(result.matchStart).toBeGreaterThanOrEqual(0);
  });

  it("returns empty for empty inputs", () => {
    const result = extractContext("", body);
    expect(result.matchStart).toBe(-1);
  });
});

describe("preFilterAccuracy", () => {
  const format = { type: "object", required: ["topic"], properties: { topic: { type: "string" } } };
  const base = {
    ref_fuzzy_distance: 95,
    payload: { topic: "pricing" },
  };

  it("passes when fuzz clears the cutoff and payload validates", () => {
    const r = preFilterAccuracy(base, format, 80);
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/pre-filter/);
  });

  it("fails when fuzz is below the cutoff", () => {
    const r = preFilterAccuracy({ ...base, ref_fuzzy_distance: 40 }, format, 80);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/40/);
    expect(r.reason).toMatch(/cutoff/);
  });

  it("fails when payload does not conform to payload_format", () => {
    const r = preFilterAccuracy(
      { ...base, payload: { wrong_field: 1 } },
      format,
      80,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/payload/);
  });

  it("skips schema check entirely when payload_format is null (default flow)", () => {
    expect(preFilterAccuracy({ ...base, payload: {} }, null, 80).pass).toBe(true);
    expect(
      preFilterAccuracy({ ...base, payload: { anything: "at all" } }, null, 80).pass,
    ).toBe(true);
  });

  it("fails on fuzz gate even when payload_format is null", () => {
    const r = preFilterAccuracy({ ...base, ref_fuzzy_distance: 20 }, null, 80);
    expect(r.pass).toBe(false);
  });

  it("respects a custom cutoff", () => {
    expect(preFilterAccuracy({ ...base, ref_fuzzy_distance: 65 }, null, 60).pass).toBe(true);
    expect(preFilterAccuracy({ ...base, ref_fuzzy_distance: 65 }, null, 70).pass).toBe(false);
  });
});

describe("validatePayload", () => {
  it("accepts when schema is empty", () => {
    expect(validatePayload({ anything: 1 }, {})).toBe(true);
  });

  it("validates against a JSON Schema", () => {
    const schema = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "number" } },
    };
    expect(validatePayload({ x: 1 }, schema)).toBe(true);
    expect(validatePayload({ x: "not a number" }, schema)).toBe(false);
    expect(validatePayload({}, schema)).toBe(false);
  });
});
