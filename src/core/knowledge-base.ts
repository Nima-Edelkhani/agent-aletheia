import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { knowledgeBaseDir } from "./config";
import type { DocMeta, StoredDoc } from "./types";

/**
 * Multi-format adapter for the knowledge base.
 *
 * `listMetadata()` and `loadDoc()` support four file formats. All parsing
 * happens IN MEMORY — no derived JSON is ever written back to disk. Source
 * files stay the single source of truth.
 *
 *   .json  { id, metadata, body }               — canonical Aletheia shape
 *   .md    filename → id · YAML frontmatter → metadata · rest → body
 *   .txt   filename → id · { type: "text" } → metadata · file → body
 *   .xml   filename → id · <metadata> child OR root attrs → metadata
 *                        · <body> child OR concatenated text → body
 *
 * For non-JSON, the filename INCLUDES the extension so `notes.md` and
 * `notes.txt` don't collide on `id`. JSON docs keep whatever `id` field
 * they carry in the file — backwards-compatible with existing corpora.
 *
 * Unparseable or unsupported files are skipped, and every skip is logged
 * to stderr with a reason. Callers that want to surface the skipped list
 * (e.g. the UI's KB panel) can use `listMetadataReport()` instead of
 * `listMetadata()`.
 */

const SUPPORTED_EXTENSIONS = new Set([".json", ".md", ".txt", ".xml"]);

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface MetadataReport {
  docs: DocMeta[];
  skipped: SkippedFile[];
}

/**
 * Returns the metadata index for every parseable doc in the knowledge base.
 * Bodies are never loaded here — the orchestrator's filter step is guaranteed
 * a body-free view.
 */
export async function listMetadata(dir: string = knowledgeBaseDir()): Promise<DocMeta[]> {
  const { docs } = await listMetadataReport(dir);
  return docs;
}

/**
 * Same as `listMetadata()` but also returns a list of files that were
 * skipped and why. Used by the KB panel to surface `10 loaded · 2 skipped`.
 */
export async function listMetadataReport(
  dir: string = knowledgeBaseDir(),
): Promise<MetadataReport> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { docs: [], skipped: [] };
    }
    throw err;
  }

  const docs: DocMeta[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of entries) {
    if (file.startsWith(".")) continue;

    const ext = extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      const reason = ext
        ? `unsupported extension ${ext}`
        : "no extension";
      skipped.push({ file, reason });
      warn(file, reason);
      continue;
    }

    try {
      const raw = await readFile(join(dir, file), "utf8");
      const parsed = parseByExtension(file, ext, raw);
      // Project explicitly to prevent body leak.
      docs.push({ id: parsed.id, metadata: parsed.metadata });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason });
      warn(file, reason);
    }
  }

  return { docs, skipped };
}

/**
 * Loads a single doc by id. This is the ONLY path by which a doc body
 * should enter memory during a sub-agent's execution. Callers pass the
 * id returned by `listMetadata()`, so extension dispatch happens by
 * matching against every supported extension until we find the right file.
 */
export async function loadDoc(
  docId: string,
  dir: string = knowledgeBaseDir(),
): Promise<StoredDoc> {
  const entries = await readdir(dir);

  // Fast path: for non-JSON, the doc id IS the filename (with extension).
  if (entries.includes(docId)) {
    const ext = extname(docId).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(ext)) {
      const raw = await readFile(join(dir, docId), "utf8");
      return parseByExtension(docId, ext, raw);
    }
  }

  // JSON path: the id is the JSON's `id` field, filename is arbitrary.
  for (const file of entries) {
    if (extname(file).toLowerCase() !== ".json") continue;
    const raw = await readFile(join(dir, file), "utf8");
    try {
      const parsed = parseJson(file, raw);
      if (parsed.id === docId) return parsed;
    } catch {
      continue;
    }
  }

  // Slow scan for non-JSON files whose derived id might not equal filename
  // (e.g. edge cases). Not expected to hit, but preserves the old
  // "search all files" fallback for safety.
  for (const file of entries) {
    if (file.startsWith(".")) continue;
    const ext = extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext) || ext === ".json") continue;
    const raw = await readFile(join(dir, file), "utf8");
    try {
      const parsed = parseByExtension(file, ext, raw);
      if (parsed.id === docId) return parsed;
    } catch {
      continue;
    }
  }

  throw new Error(`Document not found: ${docId}`);
}

export async function loadBody(
  docId: string,
  dir: string = knowledgeBaseDir(),
): Promise<string> {
  const doc = await loadDoc(docId, dir);
  return doc.body;
}

/* ────────────────────────── parsers ────────────────────────── */

function parseByExtension(file: string, ext: string, raw: string): StoredDoc {
  switch (ext) {
    case ".json":
      return parseJson(file, raw);
    case ".md":
      return parseMarkdown(file, raw);
    case ".txt":
      return parseText(file, raw);
    case ".xml":
      return parseXml(file, raw);
    default:
      throw new Error(`unsupported extension ${ext}`);
  }
}

function parseJson(file: string, raw: string): StoredDoc {
  let parsed: StoredDoc;
  try {
    parsed = JSON.parse(raw) as StoredDoc;
  } catch (err) {
    throw new Error(
      `JSON parse error in ${file}: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!parsed || typeof parsed.id !== "string") {
    throw new Error(`JSON in ${file} is missing string \`id\``);
  }
  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    throw new Error(`JSON in ${file} is missing \`metadata\` object`);
  }
  return {
    id: parsed.id,
    metadata: parsed.metadata,
    body: typeof parsed.body === "string" ? parsed.body : "",
  };
}

function parseMarkdown(file: string, raw: string): StoredDoc {
  const { metadata, body } = splitFrontmatter(raw);
  return {
    id: file,
    metadata: { type: "markdown", ...metadata },
    body,
  };
}

function parseText(file: string, raw: string): StoredDoc {
  return {
    id: file,
    metadata: { type: "text" },
    body: raw,
  };
}

/**
 * XML dispatch:
 *   - If root has `<metadata>` and/or `<body>` children → use them directly.
 *   - Else: root attributes → metadata, all text content → body.
 * Never throws on structural surprises — falls back to a sensible default so
 * arbitrary XML dumps still surface something.
 */
function parseXml(file: string, raw: string): StoredDoc {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    trimValues: true,
    preserveOrder: false,
    parseTagValue: false,
    parseAttributeValue: false,
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(raw);
  } catch (err) {
    throw new Error(
      `XML parse error in ${file}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return { id: file, metadata: { type: "xml" }, body: raw };
  }

  const parsedObj = parsed as Record<string, unknown>;
  const rootKey = Object.keys(parsedObj).find((k) => k !== "?xml");
  const rootValue = rootKey ? parsedObj[rootKey] : parsedObj;
  const root = (typeof rootValue === "object" && rootValue !== null
    ? (rootValue as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const hasCanonical = "metadata" in root || "body" in root;

  const metadata: Record<string, unknown> = { type: "xml" };
  let body = "";

  if (hasCanonical) {
    if ("metadata" in root && typeof root.metadata === "object" && root.metadata !== null) {
      Object.assign(metadata, root.metadata as Record<string, unknown>);
    }
    if ("body" in root) {
      body = xmlToText(root.body);
    }
  } else {
    // Auto-derive: root attributes → metadata, all text descendants → body.
    for (const [k, v] of Object.entries(root)) {
      if (k.startsWith("@")) {
        metadata[k.slice(1)] = v;
      }
    }
    body = xmlToText(root);
  }

  return { id: file, metadata, body };
}

/** Recursively concatenates all text content in a parsed XML subtree. */
function xmlToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(xmlToText).filter(Boolean).join(" ");
  }
  if (typeof node === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith("@") || k === "?xml") continue;
      const text = xmlToText(v);
      if (text) out.push(text);
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/* ────────────────────────── YAML frontmatter ────────────────────────── */

/**
 * Splits a markdown file into an optional YAML frontmatter block and the
 * body below it. Minimal YAML — only flat `key: value` lines are recognized.
 * Values are parsed as strings unless they look like numbers, booleans, or
 * a JSON-shaped literal (arrays / objects). This covers 95% of real-world
 * frontmatter without pulling in a full YAML library.
 */
function splitFrontmatter(raw: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const fenceMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fenceMatch) {
    return { metadata: {}, body: raw };
  }

  const [, block, rest] = fenceMatch;
  const metadata: Record<string, unknown> = {};

  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kvMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    metadata[key] = parseFrontmatterValue(rawValue);
  }

  return { metadata, body: rest ?? "" };
}

function parseFrontmatterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through — return as literal string.
    }
  }
  return trimmed;
}

/* ────────────────────────── logging ────────────────────────── */

function warn(file: string, reason: string): void {
  // Skip logging during tests to keep vitest output clean.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  console.warn(`[knowledge-base] Skipped ${basename(file)} — ${reason}`);
}
