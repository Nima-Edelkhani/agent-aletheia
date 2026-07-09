// Notion MCP corpus source — implementation lands in the next task.
// This stub exists so `resolveCorpusSource("mcp:notion")` type-checks;
// the real explore() + loadDoc() bodies come in the following commit.

import type { AletheiaConfig } from "../types";
import type { CorpusSource, ExploreResult } from "./types";
import type { StoredDoc } from "../types";

export class NotionMcpCorpusSource implements CorpusSource {
  readonly kind = "mcp:notion" as const;

  constructor() {
    const token = process.env.ALETHEIA_NOTION_TOKEN;
    if (!token) {
      throw new Error(
        "ALETHEIA_NOTION_TOKEN is not set. Run `pnpm aletheia connect notion` to configure.",
      );
    }
  }

  async explore(_question: string, _config: AletheiaConfig): Promise<ExploreResult> {
    throw new Error("NotionMcpCorpusSource.explore is not yet implemented.");
  }

  async loadDoc(_docId: string): Promise<StoredDoc> {
    throw new Error("NotionMcpCorpusSource.loadDoc is not yet implemented.");
  }
}
