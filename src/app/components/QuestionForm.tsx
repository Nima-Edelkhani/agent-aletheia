"use client";

import { useRef, useState } from "react";
import type { AskResult } from "../actions";
import type { ProgressEvent } from "@core/types";
import { ResponseView } from "./ResponseView";
import { ProgressLog } from "./ProgressLog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";

interface Entry {
  ts: number;
  event: ProgressEvent;
}

export function QuestionForm() {
  const [question, setQuestion] = useState("");
  const [extractSchema, setExtractSchema] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [startedAt, setStartedAt] = useState<number>(0);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || running) return;
    setError(null);
    setResult(null);
    setEntries([]);

    let specifiedFindingFormat: Record<string, unknown> | undefined;
    if (extractSchema.trim()) {
      try {
        specifiedFindingFormat = JSON.parse(extractSchema);
      } catch (err) {
        setError(
          `Extraction schema is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    const t0 = Date.now();
    setStartedAt(t0);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          specified_finding_format: specifiedFindingFormat ?? null,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as
            | { type: "progress"; event: ProgressEvent }
            | { type: "result"; response: AskResult["response"]; trace: AskResult["trace"] }
            | { type: "error"; message: string };
          if (msg.type === "progress") {
            setEntries((prev) => [...prev, { ts: Date.now(), event: msg.event }]);
          } else if (msg.type === "result") {
            setResult({ response: msg.response, trace: msg.trace });
          } else {
            setError(msg.message);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(e as unknown as React.FormEvent);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit}>
        <Card className="border border-neutral-200 shadow-sm">
          <CardContent className="space-y-3 p-4">
            <Label
              htmlFor="q"
              className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted"
            >
              Question
            </Label>
            <Textarea
              id="q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder="Ask a question, e.g. Which customers raised pricing concerns in the last 3 months?"
              className="min-h-[80px] w-full resize-y border-0 bg-transparent p-2 text-sm shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2 border-t border-neutral-100 pt-2">
              <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-muted"
                  >
                    {showAdvanced ? (
                      <ChevronDown className="mr-1 size-3" />
                    ) : (
                      <ChevronRight className="mr-1 size-3" />
                    )}
                    Advanced
                  </Button>
                </CollapsibleTrigger>
              </Collapsible>
              <div className="flex items-center gap-2">
                {running && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={cancel}
                    className="h-8 text-xs text-muted"
                  >
                    <X className="mr-1 size-3" />
                    cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={running || !question.trim()}
                  className="h-8 gap-1"
                >
                  {running ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      Thinking…
                    </>
                  ) : (
                    <>
                      Ask
                      <ArrowUp className="size-3" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </form>

      <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
        <CollapsibleContent>
          <Card className="border border-neutral-200 bg-neutral-50">
            <CardContent className="space-y-2 p-4">
              <Label
                htmlFor="extract"
                className="text-xs font-semibold uppercase tracking-wider text-muted"
              >
                Typed extraction schema (optional)
              </Label>
              <p className="text-xs text-muted">
                JSON Schema. When provided, every signal will also include a{" "}
                <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
                  payload
                </code>{" "}
                object conforming to this schema. Leave empty for the default flow.
              </p>
              <Textarea
                id="extract"
                rows={6}
                value={extractSchema}
                onChange={(e) => setExtractSchema(e.target.value)}
                spellCheck={false}
                placeholder={`{\n  "type": "object",\n  "additionalProperties": false,\n  "required": ["deal_stage", "amount_usd"],\n  "properties": {\n    "deal_stage": {"type": "string"},\n    "amount_usd": {"type": "number"}\n  }\n}`}
                className="font-mono text-xs"
              />
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {(running || entries.length > 0) && (
        <ProgressLog entries={entries} startedAt={startedAt} running={running} />
      )}

      {result && <ResponseView result={result} />}
    </div>
  );
}
