import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfigForProcessTransport } from "@anthropic-ai/claude-agent-sdk";
import {
  makeReportScopeServer,
  REPORT_SCOPE_TOOL,
} from "../mcp/report-scope";
import { usageToCost } from "../cost";
import type { AletheiaConfig, DocMeta } from "../types";
import type { ExploreResult } from "./types";

export interface ExplorationAgentOptions {
  /** MCP servers to expose to the exploration agent (e.g. { notion: {...} }). */
  mcpServers: Record<string, McpServerConfigForProcessTransport>;
  /**
   * Fully-qualified MCP tool names the agent is allowed to call, on top of
   * the built-in `report_scope`. Example: ["mcp__notion__search",
   * "mcp__notion__retrieve_page"].
   */
  allowedMcpTools: string[];
  /** Full system prompt for the exploration agent. */
  systemPrompt: string;
  /** User's original question. Passed as the prompt verbatim. */
  question: string;
  /**
   * Maximum turns the exploration agent may take. Filesystem is one-shot;
   * MCP needs a few turns to search + narrow (default 8).
   */
  maxTurns?: number;
  /** Aletheia model config; the filter model is used for the agent. */
  config: AletheiaConfig;
}

/**
 * Runs an exploration agent that has access to the given MCP tools plus the
 * built-in `report_scope` tool. Returns the emitted scope + reasoning + cost.
 *
 * Its context lives only inside this function — nothing about the workspace
 * bleeds back into the orchestrator except what the agent chose to include
 * in its `report_scope` payload. This is what preserves the "orchestrator
 * context never explodes" invariant.
 */
export async function runExplorationAgent(
  opts: ExplorationAgentOptions,
): Promise<ExploreResult> {
  const { server, capture } = makeReportScopeServer();

  let sdkCost = 0;

  try {
    const q = query({
      prompt: opts.question,
      options: {
        model: opts.config.models.filter,
        systemPrompt: opts.systemPrompt,
        mcpServers: {
          ...opts.mcpServers,
          "aletheia-scope": server,
        },
        allowedTools: [...opts.allowedMcpTools, REPORT_SCOPE_TOOL],
        settingSources: [],
        maxTurns: opts.maxTurns ?? 8,
        permissionMode: "bypassPermissions",
      },
    });

    let usageCost = 0;
    let finalTotal: number | undefined;

    for await (const msg of q) {
      const anyMsg = msg as unknown as {
        type: string;
        usage?: unknown;
        total_cost_usd?: number;
        message?: { usage?: unknown };
      };
      if (typeof anyMsg.total_cost_usd === "number") {
        finalTotal = anyMsg.total_cost_usd;
      }
      const usage = anyMsg.message?.usage ?? anyMsg.usage;
      if (usage && anyMsg.type !== "result") {
        usageCost += usageToCost(usage as never, opts.config.models.filter);
      }
    }
    sdkCost = finalTotal ?? usageCost;
  } catch (err) {
    // If the agent errored before emitting, return an empty scope so the
    // orchestrator can continue with a no-evidence answer rather than
    // failing the whole request.
    return {
      scope_of_exploration: [],
      scope_metadata: [],
      reasoning: `Exploration agent error: ${err instanceof Error ? err.message : String(err)}`,
      cost: sdkCost,
    };
  }

  if (!capture.value) {
    return {
      scope_of_exploration: [],
      scope_metadata: [],
      reasoning:
        "Exploration agent did not emit a scope. This usually means no relevant docs were found.",
      cost: sdkCost,
    };
  }

  const items = capture.value.scope;
  const scope_of_exploration = items.map((it) => it.id);
  const scope_metadata: DocMeta[] = items.map((it) => ({
    id: it.id,
    metadata: it.metadata,
  }));

  return {
    scope_of_exploration,
    scope_metadata,
    reasoning: capture.value.reasoning,
    cost: sdkCost,
  };
}
