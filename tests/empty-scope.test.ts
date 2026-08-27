import { describe, it, expect } from "vitest";
import { pickEmptyScopeMessage } from "../src/core/empty-scope";

/**
 * Guards the honest "nothing in scope" answers the orchestrator returns when
 * it short-circuits. Pure branching on (kb size, resolved window); CI-gated.
 */
describe("pickEmptyScopeMessage", () => {
  it("reports an empty knowledge base regardless of the window", () => {
    const withFilter = pickEmptyScopeMessage(0, { start: "2026-08-01", end: "2026-08-31" });
    const noFilter = pickEmptyScopeMessage(0, null);
    for (const msg of [withFilter, noFilter]) {
      expect(msg.response_text).toContain("knowledge base is empty");
      expect(msg.response_reasoning).toContain("no documents in the knowledge base");
    }
  });

  it("gives a time-window answer naming the window and doc count", () => {
    const msg = pickEmptyScopeMessage(10, { start: "2026-08-01", end: "2026-08-31" });
    expect(msg.response_text).toContain("No meetings");
    expect(msg.response_text).toContain("2026-08-01 to 2026-08-31");
    expect(msg.response_text).toContain("did not search any documents");
    expect(msg.response_text).toContain("10 document(s)");
    expect(msg.response_reasoning).toContain("time-scoped");
  });

  it("renders open-ended windows via formatWindow", () => {
    expect(
      pickEmptyScopeMessage(3, { start: "2026-07-01", end: null }).response_text,
    ).toContain("on or after 2026-07-01");
    expect(
      pickEmptyScopeMessage(3, { start: null, end: "2026-02-28" }).response_text,
    ).toContain("on or before 2026-02-28");
  });

  it("falls back to a generic filters-matched-nothing answer when no window", () => {
    const msg = pickEmptyScopeMessage(10, null);
    expect(msg.response_text).toContain("No documents matched the filters");
    expect(msg.response_text).not.toContain("time window");
    expect(msg.response_reasoning).toContain("no time");
  });

  it("prioritizes the empty-KB message over the time-window message", () => {
    // kbSize 0 wins even when a window is present — you can't be 'outside the
    // window' if there are no documents at all.
    const msg = pickEmptyScopeMessage(0, { start: "2026-01-01", end: "2026-12-31" });
    expect(msg.response_text).toContain("knowledge base is empty");
    expect(msg.response_text).not.toContain("time window");
  });
});
