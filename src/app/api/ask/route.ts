import { NextRequest } from "next/server";
import { ask } from "@core/orchestrator";
import type { PayloadFormat, ProgressEvent } from "@core/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streaming endpoint. Body:
 *   { question: string, specified_finding_format?: JSONSchema | null }
 * Response: newline-delimited JSON — one line per event:
 *   {type:"progress", event: ProgressEvent}
 *   {type:"result", response, trace}
 *   {type:"error", message}.
 */
const MISSING_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set. Add it to the .env file at the project " +
  "root (format: ANTHROPIC_API_KEY=sk-ant-your-key-here), then restart " +
  "the dev server.";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { type: "error", message: MISSING_KEY_MESSAGE, code: "missing_api_key" },
      { status: 503 },
    );
  }

  let question: string;
  let specifiedFindingFormat: PayloadFormat | undefined;
  let sourceKind: string | undefined;
  try {
    const body = (await req.json()) as {
      question?: string;
      specified_finding_format?: PayloadFormat | null;
      source_kind?: string;
    };
    if (!body.question || typeof body.question !== "string") {
      return new Response("Missing question", { status: 400 });
    }
    question = body.question;
    if (body.specified_finding_format) {
      specifiedFindingFormat = body.specified_finding_format;
    }
    if (body.source_kind && typeof body.source_kind === "string") {
      sourceKind = body.source_kind;
    }
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      const onProgress = (event: ProgressEvent) => {
        write({ type: "progress", event });
      };

      try {
        const { response, trace } = await ask(question, onProgress, {
          specifiedFindingFormat,
          sourceKind,
        });
        write({ type: "result", response, trace });
      } catch (err) {
        write({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
