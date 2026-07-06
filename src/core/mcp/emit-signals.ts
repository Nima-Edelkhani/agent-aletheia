import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PayloadFormat, SubagentEmission } from "../types";

/**
 * Builds a fresh in-process MCP server exposing one tool: `emit_signals`.
 *
 * The Zod input shape is:
 *   - Always: reference_text, finding_summary, finding_category, confidence.
 *   - Plus (only when `specifiedFindingFormat` was passed by the caller):
 *       payload: an object matching that schema (validated post-hoc via ajv
 *       in `scoring.ts` since Zod can't consume arbitrary JSON Schema).
 *
 * The sub-agent is required to call this tool EXACTLY ONCE per turn — the
 * input arrives via the handler and is stashed in a closure-scoped
 * variable that the caller reads after the SDK loop completes.
 */
export function makeEmitSignalsServer(specifiedFindingFormat?: PayloadFormat) {
  const capture: { value: SubagentEmission | null } = { value: null };

  const hasSchema = !!specifiedFindingFormat;

  const baseSignal = z.object({
    reference_text: z
      .string()
      .describe(
        "Verbatim quote from the document body that grounds this finding. Must appear in the doc.",
      ),
    finding_summary: z
      .string()
      .describe(
        "One sentence, present tense, in your own words, describing the positive finding this signal represents.",
      ),
    finding_category: z
      .string()
      .describe(
        "A short snake_case label you invent based on what the body says (e.g. pricing_uplift_objection, twilio_integration_blocker). Not from a fixed list.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Your 0.0–1.0 confidence that this finding answers the question."),
  });

  const signalSchema = hasSchema
    ? baseSignal.extend({
        payload: z
          .record(z.any())
          .describe(
            "Structured extraction conforming to the specified_finding_format JSON schema in the user message. Fill EVERY required field.",
          ),
      })
    : baseSignal;

  const inputShape = {
    kind: z
      .enum(["signals", "no_signal"])
      .describe(
        "'signals' when the doc affirmatively answers the rescoped question; 'no_signal' otherwise. Never emit 'signals' just to report absence — use 'no_signal' for that.",
      ),
    signals: z
      .array(signalSchema)
      .optional()
      .describe("Required when kind='signals'. Omit when kind='no_signal'."),
  } as const;

  const emitTool = tool(
    "emit_signals",
    "Emit signals found in the document, or emit no_signal if the document does not affirmatively answer the rescoped question. Call this tool EXACTLY ONCE per turn.",
    inputShape,
    async (args) => {
      const kind = args.kind;
      if (kind === "no_signal") {
        capture.value = { kind: "no_signal" };
      } else {
        capture.value = { kind: "signals", signals: args.signals ?? [] };
      }
      return {
        content: [{ type: "text" as const, text: "accepted" }],
      };
    },
  );

  const server = createSdkMcpServer({
    name: "aletheia-signals",
    version: "0.2.0",
    tools: [emitTool],
  });

  return { server, capture };
}

/** Fully-qualified MCP tool name as seen by the SDK's allowedTools list. */
export const EMIT_SIGNALS_TOOL = "mcp__aletheia-signals__emit_signals";
