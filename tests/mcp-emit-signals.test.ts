import { describe, it, expect } from "vitest";
import {
  EMIT_SIGNALS_TOOL,
  makeEmitSignalsServer,
} from "../src/core/mcp/emit-signals";

/**
 * These tests exercise the closure-capture contract of the MCP tool without
 * booting the whole Claude Agent SDK. The tool's handler is what actually
 * fires when a sub-agent calls `emit_signals`; we can invoke it directly.
 */
function findHandler(server: ReturnType<typeof makeEmitSignalsServer>["server"]) {
  // The SDK exposes tools via the server instance; we introspect the
  // internal tool registry to reach the handler for unit testing.
  const anySrv = server as unknown as {
    instance?: { _registeredTools?: Record<string, { handler?: unknown }> };
  };
  const registry = anySrv.instance?._registeredTools ?? {};
  const tool = registry["emit_signals"];
  if (!tool?.handler || typeof tool.handler !== "function") {
    throw new Error("emit_signals tool handler not found on server");
  }
  return tool.handler as (args: unknown, extra?: unknown) => Promise<unknown>;
}

describe("EMIT_SIGNALS_TOOL", () => {
  it("exposes the fully-qualified MCP tool name", () => {
    expect(EMIT_SIGNALS_TOOL).toBe("mcp__aletheia-signals__emit_signals");
  });
});

describe("makeEmitSignalsServer — default (no specifiedFindingFormat)", () => {
  it("captures a 'no_signal' emission", async () => {
    const { server, capture } = makeEmitSignalsServer();
    const handler = findHandler(server);
    await handler({ kind: "no_signal" }, {});
    expect(capture.value).toEqual({ kind: "no_signal" });
  });

  it("captures a 'signals' emission with finding fields", async () => {
    const { server, capture } = makeEmitSignalsServer();
    const handler = findHandler(server);
    await handler(
      {
        kind: "signals",
        signals: [
          {
            reference_text: "Yes — pricing was raised.",
            finding_summary:
              "The customer objected to per-minute pricing on the call.",
            finding_category: "per_minute_pricing_objection",
            confidence: 0.9,
          },
        ],
      },
      {},
    );
    expect(capture.value?.kind).toBe("signals");
    if (capture.value?.kind === "signals") {
      expect(capture.value.signals).toHaveLength(1);
      expect(capture.value.signals[0].finding_summary).toContain("pricing");
      expect(capture.value.signals[0].confidence).toBe(0.9);
      expect(capture.value.signals[0].payload).toBeUndefined();
    }
  });

  it("captures an empty signals array as a valid 'signals' emission", async () => {
    const { server, capture } = makeEmitSignalsServer();
    const handler = findHandler(server);
    await handler({ kind: "signals", signals: [] }, {});
    expect(capture.value).toEqual({ kind: "signals", signals: [] });
  });
});

describe("makeEmitSignalsServer — with specifiedFindingFormat", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["amount_usd"],
    properties: { amount_usd: { type: "number" } },
  };

  it("accepts signals that include a `payload` field", async () => {
    const { server, capture } = makeEmitSignalsServer(schema);
    const handler = findHandler(server);
    await handler(
      {
        kind: "signals",
        signals: [
          {
            reference_text: "$490K annual contract.",
            finding_summary: "Nimbus Health cited $490K in annual contract value.",
            finding_category: "contract_value_reference",
            confidence: 0.85,
            payload: { amount_usd: 490000 },
          },
        ],
      },
      {},
    );
    expect(capture.value?.kind).toBe("signals");
    if (capture.value?.kind === "signals") {
      expect(capture.value.signals[0].payload).toEqual({ amount_usd: 490000 });
    }
  });
});

describe("makeEmitSignalsServer — capture invariants", () => {
  it("each call to makeEmitSignalsServer returns an independent capture", () => {
    const a = makeEmitSignalsServer();
    const b = makeEmitSignalsServer();
    expect(a.capture).not.toBe(b.capture);
    expect(a.server).not.toBe(b.server);
  });

  it("capture starts as null", () => {
    const { capture } = makeEmitSignalsServer();
    expect(capture.value).toBeNull();
  });
});
