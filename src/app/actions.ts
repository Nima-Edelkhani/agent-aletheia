"use server";

import { ask, type OrchestratorTrace } from "@core/orchestrator";
import {
  loadBody,
  listMetadata,
  listMetadataReport,
  type MetadataReport,
  type SkippedFile,
} from "@core/knowledge-base";
import type { AletheiaResponse } from "@core/types";

export type { MetadataReport, SkippedFile };

export interface AskResult {
  response: AletheiaResponse;
  trace: OrchestratorTrace;
}

export async function askAletheia(question: string): Promise<AskResult> {
  if (!question || question.trim().length === 0) {
    throw new Error("Question is required");
  }
  return await ask(question);
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
