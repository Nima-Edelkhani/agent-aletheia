import { FilesystemCorpusSource } from "./filesystem";
import type { AvailableSource, CorpusSource, CorpusSourceKind } from "./types";

export type { CorpusSource, CorpusSourceKind, AvailableSource, ExploreResult } from "./types";

/**
 * Resolve a source name to a live CorpusSource instance. Called by the
 * CLI's `--source` flag, the API route, and the ask() default.
 *
 * Adding a new source (Linear, Jira) means:
 *   1. Register its kind in CorpusSourceKind (types.ts)
 *   2. Add a case here
 *   3. Add its credential check to listAvailableSources() below
 *
 * MCP source imports are done lazily inside their cases so the filesystem
 * path never has to load MCP client dependencies. This keeps startup light
 * for users who never touch MCP.
 */
export async function resolveCorpusSource(
  kind: CorpusSourceKind = "filesystem",
): Promise<CorpusSource> {
  switch (kind) {
    case "filesystem":
      return new FilesystemCorpusSource();
    case "mcp:notion": {
      const { NotionMcpCorpusSource } = await import("./notion");
      return new NotionMcpCorpusSource();
    }
    case "mcp:linear":
      throw new Error("Linear MCP corpus source is not yet implemented.");
    case "mcp:jira":
      throw new Error("Jira MCP corpus source is not yet implemented.");
    default: {
      // Compile-time exhaustiveness check.
      const _exhaustive: never = kind;
      throw new Error(`Unknown corpus source: ${_exhaustive}`);
    }
  }
}

/**
 * Discovery for the UI dropdown. Filesystem is always present. MCP sources
 * appear only when the corresponding env token is set — so users don't see
 * options they can't actually pick.
 */
export function listAvailableSources(): AvailableSource[] {
  const sources: AvailableSource[] = [
    { kind: "filesystem", label: "Local files", configured: true },
    {
      kind: "mcp:notion",
      label: "Notion (via MCP)",
      configured: !!process.env.ALETHEIA_NOTION_TOKEN,
      hint: "Run `pnpm aletheia connect notion` to add ALETHEIA_NOTION_TOKEN to your .env.",
    },
  ];
  return sources;
}
