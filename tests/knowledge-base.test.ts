import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMetadata,
  listMetadataReport,
  loadBody,
  loadDoc,
} from "../src/core/knowledge-base";

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "aletheia-kb-test-"));

  // ── .json ─────────────────────────────────────────────
  writeFileSync(
    join(fixtureDir, "doc-a.json"),
    JSON.stringify({
      id: "doc-a",
      metadata: { type: "meeting", customer: "Acme" },
      body: "This is doc A's body. Do not leak this.",
    }),
  );
  writeFileSync(
    join(fixtureDir, "doc-b.json"),
    JSON.stringify({
      id: "doc-b",
      metadata: { type: "meeting", customer: "Beta" },
      body: "This is doc B's body.",
    }),
  );

  // ── .md with YAML frontmatter ────────────────────────
  writeFileSync(
    join(fixtureDir, "note-with-frontmatter.md"),
    `---
customer: Meridian
tier: enterprise
date: 2026-05-14
active: true
priorities: ["pricing", "integration"]
---

This is the markdown body.

## A heading

Some more content — verifiably present.`,
  );

  // ── .md WITHOUT frontmatter ──────────────────────────
  writeFileSync(
    join(fixtureDir, "note-plain.md"),
    "# Plain markdown\n\nNo frontmatter here — the whole file is body.",
  );

  // ── .md with MALFORMED frontmatter (missing closing fence) ───
  writeFileSync(
    join(fixtureDir, "note-malformed.md"),
    `---
customer: Broken
this file has no closing fence

so this is all body.`,
  );

  // ── .txt ─────────────────────────────────────────────
  writeFileSync(
    join(fixtureDir, "memo.txt"),
    "A plain-text memo, uttered by John: pricing is a concern.",
  );

  // ── .xml with canonical <document>/<metadata>/<body> ─
  writeFileSync(
    join(fixtureDir, "canonical.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<document>
  <metadata>
    <customer>Anchorline</customer>
    <date>2026-06-01</date>
    <tier>growth</tier>
  </metadata>
  <body>Anchorline discussed pricing during the June call.</body>
</document>`,
  );

  // ── .xml with root attributes (auto-derive path) ─────
  writeFileSync(
    join(fixtureDir, "auto.xml"),
    `<transcript customer="Globex" date="2026-04-04">
  <turn speaker="Sarah">Welcome.</turn>
  <turn speaker="John">Thanks. Let's talk about pricing.</turn>
</transcript>`,
  );

  // ── unsupported extension ────────────────────────────
  writeFileSync(join(fixtureDir, "ignored.pdf"), "not really a pdf");

  // ── broken JSON ──────────────────────────────────────
  writeFileSync(join(fixtureDir, "broken.json"), "{ this is not valid json");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("listMetadata — JSON docs (backwards compat)", () => {
  it("keeps returning the JSON docs' in-file id", async () => {
    const list = await listMetadata(fixtureDir);
    const ids = list.map((d) => d.id);
    expect(ids).toContain("doc-a");
    expect(ids).toContain("doc-b");
  });

  it("does NOT include the body field at any depth", async () => {
    const list = await listMetadata(fixtureDir);
    for (const item of list) {
      const serialized = JSON.stringify(item);
      expect(serialized.includes("Do not leak this")).toBe(false);
      expect(Object.keys(item)).not.toContain("body");
    }
  });
});

describe("listMetadata — Markdown docs", () => {
  it("parses YAML frontmatter into metadata", async () => {
    const list = await listMetadata(fixtureDir);
    const md = list.find((d) => d.id === "note-with-frontmatter.md");
    expect(md).toBeDefined();
    expect(md!.metadata).toMatchObject({
      type: "markdown",
      customer: "Meridian",
      tier: "enterprise",
      date: "2026-05-14",
      active: true,
    });
    // The parsed array is inline JSON.
    expect(md!.metadata.priorities).toEqual(["pricing", "integration"]);
  });

  it("falls back to empty metadata when no frontmatter is present", async () => {
    const list = await listMetadata(fixtureDir);
    const plain = list.find((d) => d.id === "note-plain.md");
    expect(plain).toBeDefined();
    expect(plain!.metadata).toEqual({ type: "markdown" });
  });

  it("gracefully handles malformed frontmatter (missing closing fence)", async () => {
    const list = await listMetadata(fixtureDir);
    const bad = list.find((d) => d.id === "note-malformed.md");
    expect(bad).toBeDefined();
    // Without a proper closing fence, whole file is treated as body.
    expect(bad!.metadata).toEqual({ type: "markdown" });
  });

  it("loadBody returns the markdown body without the frontmatter block", async () => {
    const body = await loadBody("note-with-frontmatter.md", fixtureDir);
    expect(body).toContain("A heading");
    expect(body).toContain("verifiably present");
    expect(body).not.toContain("customer: Meridian");
  });
});

describe("listMetadata — Text docs", () => {
  it("uses filename with extension as id", async () => {
    const list = await listMetadata(fixtureDir);
    const memo = list.find((d) => d.id === "memo.txt");
    expect(memo).toBeDefined();
    expect(memo!.metadata).toEqual({ type: "text" });
  });

  it("loadBody returns the raw file contents", async () => {
    const body = await loadBody("memo.txt", fixtureDir);
    expect(body).toContain("pricing is a concern");
  });
});

describe("listMetadata — XML docs (canonical)", () => {
  it("extracts metadata from <metadata> child and body from <body> child", async () => {
    const list = await listMetadata(fixtureDir);
    const doc = list.find((d) => d.id === "canonical.xml");
    expect(doc).toBeDefined();
    expect(doc!.metadata).toMatchObject({
      type: "xml",
      customer: "Anchorline",
      date: "2026-06-01",
      tier: "growth",
    });
  });

  it("loadBody returns the <body> element's text", async () => {
    const body = await loadBody("canonical.xml", fixtureDir);
    expect(body).toContain("Anchorline discussed pricing");
  });
});

describe("listMetadata — XML docs (auto-derive)", () => {
  it("uses root element attributes as metadata", async () => {
    const list = await listMetadata(fixtureDir);
    const doc = list.find((d) => d.id === "auto.xml");
    expect(doc).toBeDefined();
    expect(doc!.metadata).toMatchObject({
      type: "xml",
      customer: "Globex",
      date: "2026-04-04",
    });
  });

  it("concatenates all descendant text into body", async () => {
    const body = await loadBody("auto.xml", fixtureDir);
    expect(body).toContain("Welcome");
    expect(body).toContain("Let's talk about pricing");
  });
});

describe("listMetadata — collision-free IDs across formats", () => {
  it("differentiates same-basename files by including the extension", async () => {
    const list = await listMetadata(fixtureDir);
    const ids = list.map((d) => d.id);
    // note-plain.md and note-with-frontmatter.md coexist without id collision.
    const uniqueCount = new Set(ids).size;
    expect(uniqueCount).toBe(ids.length);
  });
});

describe("listMetadataReport — skipped files", () => {
  it("reports unsupported extensions with a helpful reason", async () => {
    const { skipped } = await listMetadataReport(fixtureDir);
    const pdf = skipped.find((s) => s.file === "ignored.pdf");
    expect(pdf).toBeDefined();
    expect(pdf!.reason.toLowerCase()).toContain("unsupported");
  });

  it("reports JSON parse errors with a reason", async () => {
    const { skipped } = await listMetadataReport(fixtureDir);
    const broken = skipped.find((s) => s.file === "broken.json");
    expect(broken).toBeDefined();
    expect(broken!.reason.toLowerCase()).toContain("json");
  });

  it("docs and skipped are disjoint", async () => {
    const { docs, skipped } = await listMetadataReport(fixtureDir);
    const docIds = new Set(docs.map((d) => d.id));
    for (const s of skipped) {
      expect(docIds.has(s.file)).toBe(false);
    }
  });
});

describe("loadDoc — cross-format", () => {
  it("loads a JSON doc by its in-file id", async () => {
    const doc = await loadDoc("doc-a", fixtureDir);
    expect(doc.id).toBe("doc-a");
    expect(doc.body).toContain("doc A");
  });

  it("loads a markdown doc by filename id", async () => {
    const doc = await loadDoc("note-with-frontmatter.md", fixtureDir);
    expect(doc.id).toBe("note-with-frontmatter.md");
    expect(doc.metadata.customer).toBe("Meridian");
  });

  it("loads a text doc by filename id", async () => {
    const doc = await loadDoc("memo.txt", fixtureDir);
    expect(doc.body).toContain("pricing");
  });

  it("loads an XML doc by filename id", async () => {
    const doc = await loadDoc("canonical.xml", fixtureDir);
    expect(doc.metadata.customer).toBe("Anchorline");
  });

  it("throws for unknown doc id", async () => {
    await expect(loadDoc("does-not-exist", fixtureDir)).rejects.toThrow();
  });
});

describe("listMetadata — directory errors", () => {
  it("returns empty array when directory does not exist", async () => {
    const list = await listMetadata("/tmp/does-not-exist-alh98zx");
    expect(list).toEqual([]);
  });
});
