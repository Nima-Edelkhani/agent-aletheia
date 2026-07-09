"use client";

import type { ProgressEvent } from "@core/types";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
  XCircle,
  AlertTriangle,
  Info,
} from "lucide-react";

interface Entry {
  ts: number;
  event: ProgressEvent;
}

export function ProgressLog({
  entries,
  startedAt,
  running,
}: {
  entries: Entry[];
  startedAt: number;
  running: boolean;
}) {
  if (entries.length === 0 && !running) return null;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-muted">
        {running ? (
          <Spinner className="size-3" />
        ) : (
          <CheckCircle2 className="size-3 text-emerald-600" />
        )}
        Orchestrator progress
      </div>
      <Task defaultOpen>
        <TaskTrigger
          title={`${entries.length} event${entries.length === 1 ? "" : "s"}${running ? " · running…" : ""}`}
        />
        <TaskContent>
          <ol className="mt-2 space-y-1.5">
            {entries.map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="w-10 flex-shrink-0 text-[11px] tabular-nums text-muted">
                  {((e.ts - startedAt) / 1000).toFixed(1)}s
                </span>
                <TaskItem className="flex-1 text-sm">
                  <ProgressLine event={e.event} />
                </TaskItem>
              </li>
            ))}
          </ol>
        </TaskContent>
      </Task>
    </section>
  );
}

function ProgressLine({ event: e }: { event: ProgressEvent }) {
  switch (e.type) {
    case "started":
      return (
        <span className="flex items-center gap-2">
          <Info className="size-3.5 text-neutral-600" />
          Received question.{" "}
          {typeof e.kb_size === "number" ? (
            <>KB has <strong>{e.kb_size}</strong> doc(s).</>
          ) : (
            <>Source: <strong>{e.source_kind ?? "unknown"}</strong>.</>
          )}
        </span>
      );
    case "filter_started":
      return (
        <span className="flex items-center gap-2 text-muted">
          <CircleDashed className="size-3.5" />
          Step 1: filtering by metadata…
        </span>
      );
    case "filter_done":
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Step 1: <strong>{e.scope_of_exploration.length}</strong> doc(s) in scope
          <span className="text-muted">(+${e.cost.toFixed(4)})</span>
        </span>
      );
    case "rescope_started":
      return (
        <span className="flex items-center gap-2 text-muted">
          <CircleDashed className="size-3.5" />
          Step 2: rescoping…
        </span>
      );
    case "rescope_done":
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Step 2: rescoped{" "}
          <span className="italic text-muted">
            &ldquo;{truncate(e.question_rescoped, 60)}&rdquo;
          </span>
          <span className="text-muted">(+${e.cost.toFixed(4)})</span>
        </span>
      );
    case "fanout_started":
      return (
        <span className="flex items-center gap-2">
          <CircleDashed className="size-3.5" />
          Step 3: spawning <strong>{e.doc_ids.length}</strong> sub-agent(s)…
        </span>
      );
    case "subagent_started":
      return (
        <span className="flex items-center gap-2 pl-4 text-muted">
          <CircleDot className="size-3" />
          sub-agent started
          <TaskItemFile>{e.doc_id}</TaskItemFile>
        </span>
      );
    case "subagent_done":
      if (e.error) {
        return (
          <span className="flex items-center gap-2 pl-4">
            <XCircle className="size-3.5 text-red-600" />
            sub-agent error
            <TaskItemFile>{e.doc_id}</TaskItemFile>
            <span className="text-red-700">{e.error}</span>
          </span>
        );
      }
      if (e.no_signal) {
        return (
          <span className="flex items-center gap-2 pl-4 text-muted">
            <CircleDot className="size-3" />
            no-signal
            <TaskItemFile>{e.doc_id}</TaskItemFile>
            <span className="text-muted">({(e.duration_ms / 1000).toFixed(1)}s)</span>
          </span>
        );
      }
      return (
        <span className="flex items-center gap-2 pl-4">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          emitted {e.signal_count} signal(s)
          <TaskItemFile>{e.doc_id}</TaskItemFile>
          <span className="text-muted">
            ({(e.duration_ms / 1000).toFixed(1)}s, +${e.cost.toFixed(4)})
          </span>
        </span>
      );
    case "fanout_done":
      if (e.timed_out_hard)
        return (
          <span className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="size-3.5" />
            Step 3: hard timeout reached.
          </span>
        );
      if (e.timed_out_soft)
        return (
          <span className="flex items-center gap-2 text-amber-700">
            <AlertTriangle className="size-3.5" />
            Step 3: soft timeout reached (≥90% done).
          </span>
        );
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Step 3: all sub-agents complete.
        </span>
      );
    case "signal_filter_done":
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Step 4: filter — kept <strong>{e.kept}</strong>, dropped {e.dropped}.
        </span>
      );
    case "aggregate_started":
      return (
        <span className="flex items-center gap-2 text-muted">
          <CircleDashed className="size-3.5" />
          Step 5: aggregating…
        </span>
      );
    case "aggregate_done":
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Step 5: answer composed
          <span className="text-muted">(+${e.cost.toFixed(4)})</span>
        </span>
      );
    case "finished":
      return (
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          Finished in {(e.delay_ms / 1000).toFixed(1)}s · total ≈ $
          {e.total_cost.toFixed(4)}
        </span>
      );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
