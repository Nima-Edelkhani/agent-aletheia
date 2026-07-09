import { describe, expect, it, beforeAll } from "vitest";
import {
  NotionMcpCorpusSource,
  notionDocId,
  stripNotionPrefix,
} from "../../src/core/corpus/notion";
import { makeNotionSourceWithMockClient } from "../../evals/fixtures/mock-notion-mcp";

describe("NotionMcpCorpusSource — id helpers", () => {
  it("round-trips a page uuid through notionDocId / stripNotionPrefix", () => {
    const raw = "abc-123-def";
    const wrapped = notionDocId(raw);
    expect(wrapped).toBe("mcp:notion:page:abc-123-def");
    expect(stripNotionPrefix(wrapped)).toBe(raw);
  });

  it("refuses to strip a non-Notion doc id", () => {
    expect(() => stripNotionPrefix("mtg-2026-06-12-anything")).toThrow(/Notion/);
  });
});

describe("NotionMcpCorpusSource — construction", () => {
  it("throws a helpful error when ALETHEIA_NOTION_TOKEN is missing", () => {
    const before = process.env.ALETHEIA_NOTION_TOKEN;
    delete process.env.ALETHEIA_NOTION_TOKEN;
    try {
      expect(() => new NotionMcpCorpusSource()).toThrow(
        /ALETHEIA_NOTION_TOKEN/,
      );
    } finally {
      if (before !== undefined) process.env.ALETHEIA_NOTION_TOKEN = before;
    }
  });
});

describe("NotionMcpCorpusSource — loadDoc via injected client", () => {
  let src: NotionMcpCorpusSource;

  beforeAll(async () => {
    src = await makeNotionSourceWithMockClient();
  });

  it("declares kind='mcp:notion'", () => {
    expect(src.kind).toBe("mcp:notion");
  });

  it("rejects a doc id lacking the mcp:notion:page: prefix", async () => {
    await expect(src.loadDoc("mtg-2026-06-12-nope")).rejects.toThrow(
      /mcp:notion:page:/,
    );
  });

  it("loads a Voxly page as if it were a Notion page", async () => {
    // Voxly corpus meeting ids look like mtg-YYYY-MM-DD-<slug>. We know
    // one from the seeded example set. If this fails because the example
    // corpus was edited, update the id — the assertion is the shape, not
    // the content.
    const anyMeetingId = "mtg-2026-06-12-meridian_retail-feature_request";
    const doc = await src.loadDoc(notionDocId(anyMeetingId));
    expect(doc.id).toBe(notionDocId(anyMeetingId));
    // metadata is derived from Notion page properties on the real path;
    // through the mock, the Voxly metadata comes through as-is on top of
    // synthesized title/date fields.
    expect(typeof doc.metadata).toBe("object");
    expect(doc.body.length).toBeGreaterThan(0);
    // The body is rendered markdown from mock "blocks", not the raw JSON,
    // so make sure real content is in there.
    expect(doc.body).toMatch(/Meridian|meridian/i);
  });
});
