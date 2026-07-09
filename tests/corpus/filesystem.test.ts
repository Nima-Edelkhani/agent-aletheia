import { describe, expect, it } from "vitest";
import { FilesystemCorpusSource } from "../../src/core/corpus/filesystem";

describe("FilesystemCorpusSource", () => {
  it("declares kind='filesystem'", () => {
    const src = new FilesystemCorpusSource();
    expect(src.kind).toBe("filesystem");
  });

  it("exposes listMetadata (used by CLI list-docs) and never leaks bodies", async () => {
    const src = new FilesystemCorpusSource();
    const list = await src.listMetadata!();
    // Interface-level restatement of the classic invariant: metadata
    // returned by the source never contains a body field at any depth.
    // This is the guarantee the filter step relies on so it can dump the
    // whole index into an LLM prompt safely.
    for (const item of list) {
      const serialized = JSON.stringify(item);
      expect(Object.keys(item)).not.toContain("body");
      expect(serialized).not.toMatch(/"body"\s*:/);
    }
  });

  it("loadDoc round-trips a doc from the seeded knowledge base", async () => {
    const src = new FilesystemCorpusSource();
    const list = await src.listMetadata!();
    if (list.length === 0) return; // KB may be empty in a fresh checkout
    const first = list[0];
    const doc = await src.loadDoc(first.id);
    expect(doc.id).toBe(first.id);
    expect(typeof doc.body).toBe("string");
    expect(doc.body.length).toBeGreaterThan(0);
  });
});
