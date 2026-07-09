import type { AletheiaConfig } from "../types";
import { listMetadata, loadDoc } from "../knowledge-base";
import { callJson } from "../llm";
import type { DocMeta, StoredDoc } from "../types";
import type { CorpusSource, ExploreResult } from "./types";

/**
 * Filesystem-backed corpus source. Reads from `knowledge-base/` (or wherever
 * ALETHEIA_KB_DIR points). This is the default source and preserves the
 * original single-LLM-call filter behavior — the entire metadata index is
 * embedded in one prompt.
 *
 * Zero behavior change from the pre-corpus-abstraction version. The MCP
 * sources deliberately do NOT inherit or extend this class; they implement
 * `CorpusSource` independently so their behavior can diverge as needed
 * (multi-turn exploration, pagination, etc.).
 */
export class FilesystemCorpusSource implements CorpusSource {
  readonly kind = "filesystem" as const;

  async explore(question: string, config: AletheiaConfig): Promise<ExploreResult> {
    const metadata = await listMetadata();
    if (metadata.length === 0) {
      return {
        scope_of_exploration: [],
        scope_metadata: [],
        reasoning: "Knowledge base is empty.",
        cost: 0,
      };
    }

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = [
      "You are the orchestrator's filter step for Aletheia.",
      "Given the user's question and the metadata index for every document in the",
      "knowledge base, produce `scope_of_exploration`: the list of doc IDs that",
      "must be read in detail.",
      "",
      `Today's date is ${today}. Interpret every relative time expression`,
      `("last month", "past 3 weeks", "since March", "past quarter", "in Q1")`,
      "against this date.",
      "",
      "You filter STRICTLY on metadata that is directly derivable from the",
      "structured fields — you never infer topical content from metadata. The",
      "sub-agents will read bodies and decide what's relevant.",
      "",
      "Rules for constructing scope_of_exploration:",
      "",
      "  1. TIME FILTERS are the primary lever. If the question specifies a time",
      "     range (relative or absolute), include EVERY document whose `date`",
      "     falls in that range, and EXCLUDE every document that falls outside.",
      "     This is a strict inclusion + exclusion — do not prune within the",
      "     time window and do not extend beyond it.",
      "",
      "  2. STRUCTURED-METADATA FILTERS also gate scope when the question names",
      "     them explicitly: customer name, customer tier, meeting_type,",
      "     product_discussed, participant role. Combine these with the time",
      "     filter via AND (a doc must satisfy both to be in scope).",
      "",
      "  3. If the question has NO time filter and NO structured filter, include",
      "     every document. The sub-agents will decide what's relevant.",
      "",
      "  4. DO NOT try to infer topical relevance from metadata. Questions like",
      "     'about pricing', 'discussed integrations', 'raised concerns' cannot",
      "     be answered from metadata alone — always defer to the sub-agents by",
      "     leaving any doc that passes the time + structured filters in scope.",
      "     When unsure, INCLUDE.",
      "",
      "  5. Return doc IDs verbatim from the metadata index.",
    ].join("\n");

    const userMessage = [
      `Today's date: ${today}`,
      "",
      "# User question",
      question,
      "",
      "# Metadata index",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```",
      "",
      "Compute scope_of_exploration per the rules. Reasoning should name the",
      "hard filter(s) you identified (if any) and how each in-scope doc satisfies",
      "them.",
    ].join("\n");

    const result = await callJson<{ scope_of_exploration: string[]; reasoning: string }>({
      model: config.models.filter,
      systemPrompt,
      userMessage,
      toolName: "report_scope",
      toolDescription: "Report the filtered document scope for exploration.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["scope_of_exploration", "reasoning"],
        properties: {
          scope_of_exploration: {
            type: "array",
            items: { type: "string" },
            description: "Doc IDs to explore in detail.",
          },
          reasoning: { type: "string" },
        },
      },
    });

    const validIds = new Set(metadata.map((m) => m.id));
    const scope = result.data.scope_of_exploration.filter((id) => validIds.has(id));
    const scopeMetadata = scope
      .map((id) => metadata.find((m) => m.id === id))
      .filter((m): m is DocMeta => Boolean(m));

    return {
      scope_of_exploration: scope,
      scope_metadata: scopeMetadata,
      reasoning: result.data.reasoning,
      cost: result.cost,
    };
  }

  async loadDoc(docId: string): Promise<StoredDoc> {
    return loadDoc(docId);
  }

  async listMetadata(): Promise<DocMeta[]> {
    return listMetadata();
  }
}
