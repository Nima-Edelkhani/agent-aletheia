import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Per-doc metadata the exploration agent hands back for each shortlisted
 * doc. The agent sees search results (titles, properties, snippets) from
 * MCP tools and echoes the salient bits into this shape so the orchestrator
 * doesn't have to re-fetch metadata for rescope + aggregate.
 */
export interface ReportedScopeItem {
  id: string;
  metadata: Record<string, unknown>;
}

export interface ReportScopeCapture {
  value: {
    scope: ReportedScopeItem[];
    reasoning: string;
  } | null;
}

/**
 * Builds an in-process MCP server exposing one tool: `report_scope`. Used
 * by the exploration agent (see src/core/corpus/exploration-agent.ts) to
 * emit its structured output — the shortlist of doc IDs + minimal metadata
 * + a reasoning paragraph.
 *
 * Parallels emit-signals.ts. The tool's handler stashes its input in a
 * closure the caller reads after the SDK query completes.
 */
export function makeReportScopeServer() {
  const capture: ReportScopeCapture = { value: null };

  const scopeItem = z.object({
    id: z
      .string()
      .describe(
        "Fully-qualified doc ID including the source prefix (e.g. mcp:notion:page:<uuid>). Verbatim from the search tool output — never invented.",
      ),
    metadata: z
      .record(z.any())
      .describe(
        "Small object of key metadata about this doc: title, date, author, page properties, tags — whatever the MCP search returned. Sub-agents will get the full body later; this is enough for the orchestrator to compose its rescope and aggregate prompts.",
      ),
  });

  const inputShape = {
    scope_of_exploration: z
      .array(scopeItem)
      .describe(
        "The shortlist of doc IDs to explore in detail, each with minimal metadata. Order is not significant. If nothing is relevant, emit an empty array — never invent docs.",
      ),
    reasoning: z
      .string()
      .describe(
        "One paragraph explaining how the shortlist was chosen: which MCP tools were used, what filter criteria applied, and why the returned docs are relevant to the user's question.",
      ),
  } as const;

  const emitTool = tool(
    "report_scope",
    "Report the final shortlist of doc IDs to explore in detail, along with each doc's key metadata and a reasoning paragraph. Call this tool EXACTLY ONCE, after you've used the MCP's search/read tools to narrow the workspace.",
    inputShape,
    async (args) => {
      capture.value = {
        scope: args.scope_of_exploration,
        reasoning: args.reasoning,
      };
      return {
        content: [{ type: "text" as const, text: "accepted" }],
      };
    },
  );

  const server = createSdkMcpServer({
    name: "aletheia-scope",
    version: "0.1.0",
    tools: [emitTool],
  });

  return { server, capture };
}

/** Fully-qualified MCP tool name as seen by the SDK's allowedTools list. */
export const REPORT_SCOPE_TOOL = "mcp__aletheia-scope__report_scope";
