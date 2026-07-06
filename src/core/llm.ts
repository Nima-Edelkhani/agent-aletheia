import Anthropic from "@anthropic-ai/sdk";
import { usageToCost } from "./cost";

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cached;
}

export interface JsonCallResult<T> {
  data: T;
  cost: number;
  model: string;
}

/**
 * One-shot JSON call. Uses a forced tool_use to make the model return a
 * strongly-typed object. This is the shared primitive for the
 * orchestrator's filter / rescope / aggregate / judge steps.
 */
export async function callJson<T>(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<JsonCallResult<T>> {
  const resp = await client().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.systemPrompt,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.inputSchema as never,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
    messages: [{ role: "user", content: opts.userMessage }],
  });

  const block = resp.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`LLM did not emit tool_use for ${opts.toolName}`);
  }

  return {
    data: block.input as T,
    cost: usageToCost(resp.usage as never, opts.model),
    model: opts.model,
  };
}
