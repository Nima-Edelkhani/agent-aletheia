import type { McpServerConfigForProcessTransport } from "@anthropic-ai/claude-agent-sdk";
import { runExplorationAgent } from "./exploration-agent";
import type { CorpusSource, ExploreResult } from "./types";
import type { AletheiaConfig, DocMeta, StoredDoc } from "../types";

/**
 * Minimal Notion REST client contract used by `loadDoc`. The real
 * implementation lives in this file and hits `api.notion.com` over fetch.
 * Tests + evals inject a mock that serves a canned corpus without a network
 * hop.
 */
export interface NotionClient {
  retrievePage(pageId: string): Promise<NotionPage>;
  retrieveBlocks(pageId: string): Promise<NotionBlock[]>;
}

export interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
  created_time?: string;
  last_edited_time?: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

const NOTION_PAGE_PREFIX = "mcp:notion:page:";

const DEFAULT_MCP_COMMAND = "npx";
const DEFAULT_MCP_ARGS = ["-y", "@notionhq/notion-mcp-server"];

/**
 * Notion MCP corpus source.
 *
 * Two independent code paths:
 *   - explore(): SDK-spawned exploration agent with the Notion MCP subprocess
 *     giving it search + retrieve_page tools, plus our custom `report_scope`
 *     tool that captures the shortlist.
 *   - loadDoc(): direct Notion REST calls (retrieve page + blocks), rendered
 *     to plain markdown. No LLM involved.
 *
 * The direct-REST path keeps loadDoc deterministic and cheap (no per-doc
 * agent turns). The exploration path is where the LLM does the workspace
 * navigation.
 */
export class NotionMcpCorpusSource implements CorpusSource {
  readonly kind = "mcp:notion" as const;

  private readonly token: string;
  private readonly client: NotionClient;

  constructor(client?: NotionClient) {
    const token = process.env.ALETHEIA_NOTION_TOKEN;
    if (!token) {
      throw new Error(
        "ALETHEIA_NOTION_TOKEN is not set. Run `pnpm aletheia connect notion` to configure.",
      );
    }
    this.token = token;
    this.client = client ?? new LiveNotionClient(token);
  }

  async explore(question: string, config: AletheiaConfig): Promise<ExploreResult> {
    const mcpCommand = process.env.ALETHEIA_NOTION_MCP_COMMAND ?? DEFAULT_MCP_COMMAND;
    const mcpArgs =
      process.env.ALETHEIA_NOTION_MCP_ARGS?.split(" ").filter(Boolean) ??
      DEFAULT_MCP_ARGS;

    const mcpServers: Record<string, McpServerConfigForProcessTransport> = {
      notion: {
        type: "stdio",
        command: mcpCommand,
        args: mcpArgs,
        env: {
          OPENAPI_MCP_HEADERS: JSON.stringify({
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": "2022-06-28",
          }),
        },
      },
    };

    // Notion MCP tools follow the naming convention mcp__notion__<tool>.
    // Which tools exist depends on the MCP server implementation, so we
    // allow-list the common read/search surface. Any extra tools the
    // server exposes but we don't list here simply won't be called.
    const allowedMcpTools = [
      "mcp__notion__search",
      "mcp__notion__retrieve_page",
      "mcp__notion__retrieve_database",
      "mcp__notion__query_database",
      "mcp__notion__retrieve_block_children",
    ];

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = [
      "You are the exploration step for Aletheia, a verifiable knowledge-base",
      "explorer. You have access to a Notion workspace via MCP tools plus a",
      "`report_scope` tool that captures your final shortlist.",
      "",
      `Today's date is ${today}. Interpret every relative time expression`,
      `("last month", "past 3 weeks", "since March") against this date.`,
      "",
      "Your job: given the user's question, find the Notion pages that must",
      "be read in detail to answer it. Sub-agents (running downstream) will",
      "read the FULL body of each page you shortlist and decide what's",
      "relevant — your job is scope, not content synthesis.",
      "",
      "Strategy:",
      "  1. Use `search` first to find candidate pages by keywords from the",
      "     question. Prefer specific keywords over generic ones.",
      "  2. Use `retrieve_page` (or `query_database` for databases) to see",
      "     each candidate's properties (title, date, tier, tags).",
      "  3. Filter down using time ranges and structured properties. Do NOT",
      "     try to infer topical relevance from properties alone — leave",
      "     any page in scope that passes the date + structural filters.",
      "     Sub-agents will decide topical relevance from the body.",
      "  4. When you have your shortlist, call `report_scope` EXACTLY ONCE.",
      "     Each item's `id` MUST be `mcp:notion:page:<page-uuid>` verbatim.",
      "     Each item's `metadata` should include title, date, and any",
      "     structural properties you filtered on.",
      "",
      "If nothing is relevant, call `report_scope` with an empty",
      "`scope_of_exploration` array — never invent pages.",
    ].join("\n");

    return runExplorationAgent({
      question,
      systemPrompt,
      mcpServers,
      allowedMcpTools,
      maxTurns: 8,
      config,
    });
  }

  async loadDoc(docId: string): Promise<StoredDoc> {
    if (!docId.startsWith(NOTION_PAGE_PREFIX)) {
      throw new Error(
        `NotionMcpCorpusSource: doc id must start with "${NOTION_PAGE_PREFIX}"; got ${docId}`,
      );
    }
    const pageId = docId.slice(NOTION_PAGE_PREFIX.length);

    const [page, blocks] = await Promise.all([
      this.client.retrievePage(pageId),
      this.client.retrieveBlocks(pageId),
    ]);

    return {
      id: docId,
      metadata: extractMetadata(page),
      body: renderBlocksToMarkdown(blocks),
    };
  }
}

/* ============================================================
 * Live Notion REST client
 * ============================================================ */

class LiveNotionClient implements NotionClient {
  private readonly base = "https://api.notion.com/v1";
  private readonly headers: Record<string, string>;

  constructor(token: string) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    };
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    const res = await fetch(`${this.base}/pages/${pageId}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(
        `Notion retrieve_page ${pageId} failed: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as NotionPage;
  }

  async retrieveBlocks(pageId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(`${this.base}/blocks/${pageId}/children`);
      if (cursor) url.searchParams.set("start_cursor", cursor);
      const res = await fetch(url.toString(), { headers: this.headers });
      if (!res.ok) {
        throw new Error(
          `Notion retrieve_blocks ${pageId} failed: ${res.status} ${await res.text()}`,
        );
      }
      const page = (await res.json()) as {
        results: NotionBlock[];
        next_cursor?: string;
        has_more?: boolean;
      };
      all.push(...page.results);
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return all;
  }
}

/* ============================================================
 * Notion → Aletheia shape converters
 * ============================================================ */

function extractMetadata(page: NotionPage): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  meta.title = extractTitle(page.properties);
  if (page.created_time) meta.date = page.created_time.slice(0, 10);
  if (page.last_edited_time) meta.last_edited = page.last_edited_time.slice(0, 10);
  for (const [key, value] of Object.entries(page.properties)) {
    if (key === "title" || key === "Name" || key === "Title") continue;
    const flattened = flattenProperty(value);
    if (flattened !== undefined) meta[key] = flattened;
  }
  return meta;
}

function extractTitle(properties: Record<string, unknown>): string {
  for (const key of ["title", "Title", "Name"]) {
    const prop = properties[key] as { title?: Array<{ plain_text?: string }> } | undefined;
    if (prop?.title && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return "(untitled)";
}

function flattenProperty(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (v.type === "select") {
    return (v.select as { name?: string } | null)?.name;
  }
  if (v.type === "multi_select") {
    return ((v.multi_select as Array<{ name: string }>) ?? []).map((s) => s.name);
  }
  if (v.type === "date") {
    return (v.date as { start?: string } | null)?.start;
  }
  if (v.type === "number") return v.number;
  if (v.type === "checkbox") return v.checkbox;
  if (v.type === "url") return v.url;
  if (v.type === "email") return v.email;
  if (v.type === "rich_text") {
    return ((v.rich_text as Array<{ plain_text?: string }>) ?? [])
      .map((t) => t.plain_text ?? "")
      .join("");
  }
  return undefined;
}

function renderBlocksToMarkdown(blocks: NotionBlock[]): string {
  return blocks.map(renderBlock).filter(Boolean).join("\n\n");
}

function renderBlock(block: NotionBlock): string {
  const type = block.type;
  const inner = (block as Record<string, unknown>)[type] as
    | { rich_text?: Array<{ plain_text?: string }> }
    | undefined;
  const text = (inner?.rich_text ?? [])
    .map((t) => t.plain_text ?? "")
    .join("");
  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [ ] ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "callout":
      return `> ${text}`;
    default:
      return text;
  }
}

/**
 * Convenience: strip the source prefix from a Notion doc ID. Exported for
 * mock fixtures and tests.
 */
export function stripNotionPrefix(docId: string): string {
  if (!docId.startsWith(NOTION_PAGE_PREFIX)) {
    throw new Error(`Not a Notion doc id: ${docId}`);
  }
  return docId.slice(NOTION_PAGE_PREFIX.length);
}

/**
 * Convenience: build a Notion doc ID from a page UUID.
 */
export function notionDocId(pageId: string): string {
  return `${NOTION_PAGE_PREFIX}${pageId}`;
}
