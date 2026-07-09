"use server";

import { ask, type OrchestratorTrace } from "@core/orchestrator";
import {
  loadBody,
  listMetadata,
  listMetadataReport,
  type MetadataReport,
  type SkippedFile,
} from "@core/knowledge-base";
import { listAvailableSources } from "@core/corpus";
import type { AletheiaResponse } from "@core/types";

export type { MetadataReport, SkippedFile };

export interface AskResult {
  response: AletheiaResponse;
  trace: OrchestratorTrace;
}

export async function askAletheia(
  question: string,
  sourceKind?: string,
): Promise<AskResult> {
  if (!question || question.trim().length === 0) {
    throw new Error("Question is required");
  }
  return await ask(question, undefined, { sourceKind });
}

export async function getDocBody(docId: string): Promise<string> {
  return await loadBody(docId);
}

export async function getDocList(): Promise<{ id: string; metadata: Record<string, unknown> }[]> {
  return await listMetadata();
}

export async function getDocListReport(): Promise<MetadataReport> {
  return await listMetadataReport();
}

/**
 * Which corpus sources can the UI offer? Called by the QuestionForm to
 * render the source dropdown. MCP sources appear only when their credentials
 * are present in the server-side env at request time.
 */
export async function getAvailableSources() {
  return listAvailableSources();
}
