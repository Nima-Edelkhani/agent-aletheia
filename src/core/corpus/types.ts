import type { AletheiaConfig } from "../types";
import type { DocMeta, StoredDoc } from "../types";

/**
 * The identifier for a corpus source. Used in CLI flags (--source mcp:notion),
 * UI dropdowns, and evals routing.
 */
export type CorpusSourceKind =
  | "filesystem"
  | "mcp:notion"
  | "mcp:linear"
  | "mcp:jira";

/**
 * Result of the filter/explore phase. Every source returns this shape so the
 * orchestrator's fan-out logic is source-agnostic.
 *
 * `scope_metadata` MUST be the metadata for every id in `scope_of_exploration`
 * (order aligned). The orchestrator uses it to prompt the rescope and
 * aggregate steps — those steps need per-doc metadata but should NEVER see
 * the full workspace index (which would defeat the whole point of MCP mode).
 */
export interface ExploreResult {
  scope_of_exploration: string[];
  scope_metadata: DocMeta[];
  reasoning: string;
  cost: number;
}

/**
 * A CorpusSource plugs into the orchestrator's filter phase and per-doc
 * fetch phase. Two implementations ship today:
 *
 *   - FilesystemCorpusSource: reads knowledge-base/*.json|md|txt|xml
 *   - NotionMcpCorpusSource:  talks to a Notion MCP server
 *
 * The interface is deliberately narrow. The orchestrator asks a source only
 * two questions:
 *   1. Given a user question, which doc IDs should I explore in detail?
 *   2. Give me the body for this one doc ID.
 *
 * The sub-agent NEVER calls the source. It receives the body pre-loaded in
 * its user message, so the trust boundary stays exactly where it is today.
 */
export interface CorpusSource {
  readonly kind: CorpusSourceKind;

  /**
   * Filter phase. Filesystem embeds the full metadata index in a single LLM
   * call (current behavior). MCP sources spawn an exploration agent with the
   * MCP's search/read tools and a custom `report_scope` tool that captures
   * the shortlist. Either way, the returned scope IDs are what the
   * orchestrator hands to sub-agents.
   */
  explore(question: string, config: AletheiaConfig): Promise<ExploreResult>;

  /**
   * Fetch phase. Called once per doc when the orchestrator spawns a
   * sub-agent. Returns the full doc so the sub-agent can be handed both
   * metadata (for its prompt header) and body (for its content).
   */
  loadDoc(docId: string): Promise<StoredDoc>;

  /**
   * Optional metadata index. Used by `pnpm aletheia list-docs` and by the
   * web UI's KB panel. Filesystem returns everything; MCP sources may
   * paginate or return a shallow snapshot.
   */
  listMetadata?(): Promise<DocMeta[]>;
}

/**
 * Descriptor for a source that could be selected in the UI dropdown or via
 * --source. Populated by resolveCorpusSource's discovery step so the UI can
 * show only sources whose credentials are present.
 */
export interface AvailableSource {
  kind: CorpusSourceKind;
  label: string;
  configured: boolean;
  /** Human-readable hint shown when configured=false. */
  hint?: string;
}
