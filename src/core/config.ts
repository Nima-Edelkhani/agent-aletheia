import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AletheiaConfig } from "./types";

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), "config/thresholds.json");

let cached: AletheiaConfig | null = null;

export async function loadConfig(path?: string): Promise<AletheiaConfig> {
  if (cached && !path) return cached;
  const target = path ?? process.env.ALETHEIA_CONFIG ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(target, "utf8");
  const parsed = JSON.parse(raw) as AletheiaConfig;
  if (!path) cached = parsed;
  return parsed;
}

export function knowledgeBaseDir(): string {
  return resolve(process.cwd(), process.env.ALETHEIA_KB_DIR ?? "knowledge-base");
}

export function resetConfigCache(): void {
  cached = null;
}
