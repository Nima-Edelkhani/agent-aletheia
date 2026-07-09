import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfigForProcessTransport } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runExplorationAgent } from "../../src/core/corpus/exploration-agent";
import {
  NotionMcpCorpusSource,
  notionDocId,
  stripNotionPrefix,
  type NotionClient,
  type NotionPage,
  type NotionBlock,
} from "../../src/core/corpus/notion";
import type { CorpusSource, ExploreResult } from "../../src/core/corpus/types";
import type { AletheiaConfig, DocMeta, StoredDoc } from "../../src/core/types";

/**
 * Voxly corpus JSON shape (mirrors examples/voxly-corpus/*.json).
 */
interface VoxlyDoc {
  id: string;
  metadata: Record<string, unknown>;
  body: string;
}

/**
 * Mock Notion corpus source used by evals + tests. Serves the Voxly corpus
 * as if it were a Notion workspace:
 *   - Each meeting → one fake Notion page (id: mcp:notion:page:<voxly-id>)
 *   - explore() runs the REAL exploration agent, but wired to an in-process
 *     mock Notion MCP server that exposes search + retrieve_page +
 *     retrieve_block_children. This exercises the full agent code path
 *     without hitting api.notion.com.
 *   - loadDoc() reads from the Voxly corpus directly via the mock
 *     NotionClient. Deterministic, no network.
 *
 * Environment note: this class expects a Voxly corpus root. Points at
 * `examples/voxly-corpus/` by default; override with the constructor arg
 * for tests that want a smaller fixture set.
 */
export class MockNotionCorpusSource implements CorpusSource {
  readonly kind = "mcp:notion" as const;

  private cache: VoxlyDoc[] | null = null;

  constructor(private readonly corpusDir: string = defaultCorpusDir()) {}

  async explore(question: string, config: AletheiaConfig): Promise<ExploreResult> {
    const docs = await this.loadCorpus();

    // Spin up the in-process mock Notion MCP server. `createSdkMcpServer`
    // produces the same shape the SDK accepts alongside stdio subprocesses.
    const notionServer = makeMockNotionMcpServer(docs);

    const mcpServers: Record<string, McpServerConfigForProcessTransport> = {
      notion: notionServer,
    };
    const allowedMcpTools = [
      "mcp__notion__search",
      "mcp__notion__retrieve_page",
      "mcp__notion__retrieve_block_children",
    ];

    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = [
      "You are the exploration step for Aletheia. You have access to a Notion",
      "workspace via MCP tools (`search`, `retrieve_page`,",
      "`retrieve_block_children`) and a `report_scope` tool that captures your",
      "final shortlist.",
      "",
      `Today's date is ${today}. Interpret every relative time expression`,
      `("last month", "past 3 weeks", "since March") against this date.`,
      "",
      "Job: find Notion pages that must be read in detail to answer the",
      "user's question. Sub-agents read full bodies downstream — your job is",
      "scope, not content synthesis.",
      "",
      "Strategy:",
      "  1. Use `search` with keywords from the question.",
      "  2. Use `retrieve_page` for candidates whose page properties (date,",
      "     customer, tier, meeting_type) might match.",
      "  3. Filter down using time and structured filters ONLY — never guess",
      "     topical relevance from properties. Sub-agents will decide that.",
      "  4. Call `report_scope` EXACTLY ONCE. Each item's `id` must be",
      "     verbatim from the search results (starts with mcp:notion:page:).",
      "     Each item's `metadata` should include title + the properties you",
      "     filtered on.",
      "",
      "If nothing is relevant, emit an empty scope — never invent pages.",
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
    const docs = await this.loadCorpus();
    const targetId = stripNotionPrefix(docId);
    const found = docs.find((d) => d.id === targetId);
    if (!found) throw new Error(`Mock Notion: no page for ${docId}`);
    return { id: docId, metadata: found.metadata, body: found.body };
  }

  async listMetadata(): Promise<DocMeta[]> {
    const docs = await this.loadCorpus();
    return docs.map((d) => ({ id: notionDocId(d.id), metadata: d.metadata }));
  }

  private async loadCorpus(): Promise<VoxlyDoc[]> {
    if (this.cache) return this.cache;
    const entries = await readdir(this.corpusDir);
    const docs: VoxlyDoc[] = [];
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(join(this.corpusDir, file), "utf8");
      docs.push(JSON.parse(raw) as VoxlyDoc);
    }
    this.cache = docs;
    return docs;
  }
}

/**
 * Standalone mock Notion REST client. Handy for unit tests of the real
 * NotionMcpCorpusSource's loadDoc path — you inject this in place of the
 * live client and get deterministic behavior against the Voxly corpus.
 */
export function makeMockNotionClient(docs: VoxlyDoc[]): NotionClient {
  return {
    async retrievePage(pageId: string): Promise<NotionPage> {
      const found = docs.find((d) => d.id === pageId);
      if (!found) throw new Error(`Mock Notion: page ${pageId} not found`);
      return voxlyToNotionPage(found);
    },
    async retrieveBlocks(pageId: string): Promise<NotionBlock[]> {
      const found = docs.find((d) => d.id === pageId);
      if (!found) throw new Error(`Mock Notion: page ${pageId} not found`);
      return voxlyToNotionBlocks(found);
    },
  };
}

/* ============================================================
 * Mock MCP server (search + retrieve_page + retrieve_block_children)
 * ============================================================ */

function makeMockNotionMcpServer(docs: VoxlyDoc[]) {
  const searchTool = tool(
    "search",
    "Search the Notion workspace for pages matching a query. Returns a list of {id, title, properties} objects; the id is prefixed with mcp:notion:page: and can be passed to retrieve_page.",
    { query: z.string().describe("Keywords to search for. Case-insensitive.") },
    async (args) => {
      const q = String(args.query).toLowerCase();
      const results = docs
        .filter((d) => {
          const blob = JSON.stringify(d).toLowerCase();
          return q
            .split(/\s+/)
            .filter(Boolean)
            .every((term) => blob.includes(term));
        })
        .slice(0, 20)
        .map((d) => ({
          id: notionDocId(d.id),
          title: renderTitle(d),
          properties: summariseProperties(d),
        }));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ results }, null, 2) },
        ],
      };
    },
  );

  const retrievePageTool = tool(
    "retrieve_page",
    "Retrieve one Notion page's metadata + properties. Accepts a page id (prefixed mcp:notion:page:).",
    { page_id: z.string() },
    async (args) => {
      const id = args.page_id.startsWith("mcp:notion:page:")
        ? stripNotionPrefix(args.page_id)
        : args.page_id;
      const found = docs.find((d) => d.id === id);
      if (!found) {
        return {
          content: [{ type: "text" as const, text: `not found: ${args.page_id}` }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(voxlyToNotionPage(found), null, 2),
          },
        ],
      };
    },
  );

  const retrieveBlocksTool = tool(
    "retrieve_block_children",
    "Retrieve the block children (body content) of a Notion page. Returns the page's content as a list of block objects.",
    { block_id: z.string() },
    async (args) => {
      const id = args.block_id.startsWith("mcp:notion:page:")
        ? stripNotionPrefix(args.block_id)
        : args.block_id;
      const found = docs.find((d) => d.id === id);
      if (!found) {
        return {
          content: [{ type: "text" as const, text: `not found: ${args.block_id}` }],
        };
      }
      const blocks = voxlyToNotionBlocks(found);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ results: blocks }, null, 2) },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "notion",
    version: "0.1.0",
    tools: [searchTool, retrievePageTool, retrieveBlocksTool],
  });
}

/* ============================================================
 * Voxly → Notion shape converters
 * ============================================================ */

function voxlyToNotionPage(doc: VoxlyDoc): NotionPage {
  const md = doc.metadata as {
    date?: string;
    customer?: { name?: string; tier?: string };
    meeting_type?: string;
    product_discussed?: string[];
  };
  return {
    id: doc.id,
    created_time: md.date ? `${md.date}T00:00:00.000Z` : undefined,
    last_edited_time: md.date ? `${md.date}T00:00:00.000Z` : undefined,
    properties: {
      title: {
        type: "title",
        title: [{ type: "text", plain_text: renderTitle(doc) }],
      },
      Date: { type: "date", date: md.date ? { start: md.date } : null },
      Customer: {
        type: "select",
        select: md.customer?.name ? { name: md.customer.name } : null,
      },
      Tier: {
        type: "select",
        select: md.customer?.tier ? { name: md.customer.tier } : null,
      },
      "Meeting type": {
        type: "select",
        select: md.meeting_type ? { name: md.meeting_type } : null,
      },
      Products: {
        type: "multi_select",
        multi_select: (md.product_discussed ?? []).map((p) => ({ name: p })),
      },
    },
  };
}

function voxlyToNotionBlocks(doc: VoxlyDoc): NotionBlock[] {
  const paragraphs = doc.body.split(/\n{2,}/).filter((p) => p.trim());
  return paragraphs.map((text, i) => ({
    id: `${doc.id}-block-${i}`,
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", plain_text: text.trim() }],
    },
  }));
}

function summariseProperties(doc: VoxlyDoc): Record<string, unknown> {
  const md = doc.metadata as {
    date?: string;
    customer?: { name?: string; tier?: string };
    meeting_type?: string;
  };
  return {
    date: md.date,
    customer: md.customer?.name,
    tier: md.customer?.tier,
    meeting_type: md.meeting_type,
  };
}

function renderTitle(doc: VoxlyDoc): string {
  const md = doc.metadata as {
    date?: string;
    customer?: { name?: string };
    meeting_type?: string;
  };
  const parts = [
    md.date,
    md.customer?.name,
    md.meeting_type?.replace(/_/g, " "),
  ].filter(Boolean);
  return parts.join(" · ");
}

function defaultCorpusDir(): string {
  return resolve(process.cwd(), "examples", "voxly-corpus");
}

/**
 * Convenience: build a NotionMcpCorpusSource pre-wired with a mock client
 * against the Voxly corpus. Used by unit tests that only care about
 * loadDoc's REST client path.
 */
export async function makeNotionSourceWithMockClient(): Promise<NotionMcpCorpusSource> {
  process.env.ALETHEIA_NOTION_TOKEN ??= "mock-token";
  const dir = defaultCorpusDir();
  const entries = await readdir(dir);
  const docs: VoxlyDoc[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    docs.push(JSON.parse(await readFile(join(dir, file), "utf8")) as VoxlyDoc);
  }
  return new NotionMcpCorpusSource(makeMockNotionClient(docs));
}
