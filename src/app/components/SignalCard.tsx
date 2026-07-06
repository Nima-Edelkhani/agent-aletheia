"use client";

import { useState } from "react";
import { getDocBody } from "../actions";
import type {
  AccuracyAdjudication,
  AccuracyCheck,
  Signal,
  SignalSignal,
} from "@core/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SignalThresholds {
  ref_fuzzy_distance_cutoff: number;
  confidence_cutoff: number;
}

export function SignalCard({
  signal,
  index,
  thresholds,
  droppedReason,
}: {
  signal: Signal;
  index: number;
  thresholds: SignalThresholds;
  droppedReason?: string;
}) {
  if (signal.signal_type === "no-signal") {
    return (
      <Card className="border-dashed bg-neutral-50">
        <CardContent className="flex items-center gap-2 py-2 text-xs text-muted">
          <span className="font-mono">{signal.scope_of_signal}</span>
          <Badge variant="secondary" className="text-[10px]">
            no signal
          </Badge>
        </CardContent>
      </Card>
    );
  }
  return (
    <ContributingCard
      signal={signal}
      index={index}
      thresholds={thresholds}
      droppedReason={droppedReason}
    />
  );
}

function ContributingCard({
  signal: s,
  index,
  thresholds,
  droppedReason,
}: {
  signal: SignalSignal;
  index: number;
  thresholds: SignalThresholds;
  droppedReason?: string;
}) {
  const isDropped = !!droppedReason;
  const fuzzOk = s.ref_fuzzy_distance >= thresholds.ref_fuzzy_distance_cutoff;
  const confOk = s.confidence >= thresholds.confidence_cutoff;
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [showFullBody, setShowFullBody] = useState(false);

  async function loadBodyOnce() {
    if (body || bodyLoading) return;
    setBodyLoading(true);
    try {
      const b = await getDocBody(s.scope_of_signal);
      setBody(b);
    } finally {
      setBodyLoading(false);
    }
  }

  return (
    <Card
      id={`signal-${index}`}
      className={cn(
        "signal-card scroll-mt-8",
        isDropped &&
          "border-dashed border-red-500 dark:border-red-400 opacity-90",
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-muted">
              Signal {index}
            </span>
            <span className="font-mono text-neutral-600">{s.scope_of_signal}</span>
          </CardTitle>
          {isDropped && (
            <p className="mt-1 text-[11px] font-medium text-red-700 dark:text-red-400">
              Dropped from answer · {droppedReason}
            </p>
          )}
        </div>
        {isDropped ? <DroppedBadge /> : <AccuracyBadge pass={s.accuracy_pass} />}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 1. RESCOPED QUESTION */}
        <Field label="Rescoped question">
          <p className="text-sm italic text-neutral-700">{s.question_rescoped}</p>
        </Field>

        {/* 2. QUOTE */}
        <Field
          label="Quote"
          trailing={
            <FuzzMeter
              fuzz={s.ref_fuzzy_distance}
              cutoff={thresholds.ref_fuzzy_distance_cutoff}
              belowCutoff={!fuzzOk}
            />
          }
        >
          <blockquote className="border-l-2 border-neutral-200 pl-3 text-sm leading-relaxed">
            {s.before_reference_text && (
              <span className="text-neutral-400">{s.before_reference_text} </span>
            )}
            <span className="font-semibold text-ink">{s.reference_text}</span>
            {s.after_reference_text && (
              <span className="text-neutral-400"> {s.after_reference_text}</span>
            )}
          </blockquote>
        </Field>

        {/* 3. FINDING */}
        <Field
          label="Finding"
          trailing={
            <ConfidenceMeter
              value={s.confidence}
              cutoff={thresholds.confidence_cutoff}
              belowCutoff={!confOk}
            />
          }
        >
          <p className="text-sm text-ink">{s.finding_summary}</p>
          {s.finding_category && (
            <div className="mt-1.5">
              <Badge variant="secondary" className="font-mono text-[11px]">
                {s.finding_category}
              </Badge>
            </div>
          )}
        </Field>

        {/* 4. EXTRACTION — only when specifiedFindingFormat was provided */}
        {s.payload_format !== null && Object.keys(s.payload).length > 0 && (
          <Field label="Extraction (specified_finding_format)">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
              {Object.entries(s.payload).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-neutral-500">{k}:</dt>
                  <dd className="font-mono text-neutral-700">
                    {formatPayloadValue(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </Field>
        )}

        {/* 5. ACCURACY DRILL-DOWN — visible when the judge ran */}
        {s.accuracy_adjudication && (
          <AdjudicationDrilldown adjudication={s.accuracy_adjudication} />
        )}

        {/* 6. STATS */}
        <Field label="Stats">
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Badge variant="outline" className="font-mono">
              model: {s.model}
            </Badge>
            <Badge variant="outline" className="font-mono">
              cost: ${s.cost_estimate.toFixed(5)}
            </Badge>
            <Badge variant="outline" className="font-mono">
              id: {s.id.slice(0, 8)}…
            </Badge>
          </div>
        </Field>

        <Separator />

        {/* SOURCE DOC — collapsible */}
        <Collapsible
          open={showFullBody}
          onOpenChange={(open) => {
            setShowFullBody(open);
            if (open) loadBodyOnce();
          }}
        >
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-[11px] text-muted">
              {showFullBody ? (
                <ChevronDown className="mr-1 size-3" />
              ) : (
                <ChevronRight className="mr-1 size-3" />
              )}
              {showFullBody ? "Hide" : "Show"} full document body
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2">
              {bodyLoading && (
                <p className="text-xs text-muted">Loading…</p>
              )}
              {body && (
                <ScrollArea className="max-h-96 rounded-md border bg-neutral-50">
                  <pre className="whitespace-pre-wrap p-3 text-xs leading-relaxed">
                    {body}
                  </pre>
                </ScrollArea>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          {label}
        </div>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function FuzzMeter({
  fuzz,
  cutoff,
  belowCutoff,
}: {
  fuzz: number;
  cutoff: number;
  belowCutoff: boolean;
}) {
  const color = belowCutoff
    ? "[&>[data-slot=progress-indicator]]:bg-red-500"
    : fuzz >= 90
    ? "[&>[data-slot=progress-indicator]]:bg-emerald-500"
    : "[&>[data-slot=progress-indicator]]:bg-lime-500";
  const textClass = belowCutoff ? "text-red-600 dark:text-red-400" : "text-muted";
  return (
    <div className={cn("flex items-center gap-2 text-[10px]", textClass)}>
      <span>fuzz</span>
      <Progress value={fuzz} className={cn("h-1 w-20", color)} />
      <span className={cn("tabular-nums", belowCutoff && "font-semibold")}>
        {fuzz}/100
      </span>
      {belowCutoff && (
        <span className="text-[9px] uppercase tracking-wider">
          &lt; {cutoff}
        </span>
      )}
    </div>
  );
}

function ConfidenceMeter({
  value,
  cutoff,
  belowCutoff,
}: {
  value: number;
  cutoff: number;
  belowCutoff: boolean;
}) {
  const pct = Math.round(value * 100);
  const color = belowCutoff
    ? "[&>[data-slot=progress-indicator]]:bg-red-500"
    : value >= 0.8
    ? "[&>[data-slot=progress-indicator]]:bg-emerald-500"
    : "[&>[data-slot=progress-indicator]]:bg-amber-500";
  const textClass = belowCutoff ? "text-red-600 dark:text-red-400" : "text-muted";
  return (
    <div className={cn("flex items-center gap-2 text-[10px]", textClass)}>
      <span>confidence</span>
      <Progress value={pct} className={cn("h-1 w-20", color)} />
      <span className={cn("tabular-nums", belowCutoff && "font-semibold")}>
        {pct}/100
      </span>
      {belowCutoff && (
        <span className="text-[9px] uppercase tracking-wider">
          &lt; {Math.round(cutoff * 100)}
        </span>
      )}
    </div>
  );
}

function DroppedBadge() {
  return (
    <Badge
      variant="destructive"
      className="border border-red-700 bg-red-100 text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-300"
    >
      dropped ⊘
    </Badge>
  );
}

function AccuracyBadge({ pass }: { pass: boolean }) {
  return (
    <Badge
      variant={pass ? "default" : "destructive"}
      className={
        pass
          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
          : undefined
      }
    >
      {pass ? "accuracy ✓" : "accuracy ✗"}
    </Badge>
  );
}

function formatPayloadValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return JSON.stringify(v);
}

/* ────────────────────────── Accuracy drill-down ────────────────────────── */

function AdjudicationDrilldown({
  adjudication,
}: {
  adjudication: AccuracyAdjudication;
}) {
  const [open, setOpen] = useState(false);
  const checks: { key: string; label: string; check: AccuracyCheck }[] = [
    {
      key: "reference",
      label: "Reference supports summary",
      check: adjudication.reference_supports_summary,
    },
    {
      key: "question",
      label: "Summary addresses question",
      check: adjudication.summary_addresses_question,
    },
    {
      key: "category",
      label: "Category is sensible",
      check: adjudication.category_is_sensible,
    },
  ];
  const passCount = checks.filter((c) => c.check.pass).length;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Accuracy · judge
        </div>
        <span className="text-[10px] tabular-nums text-muted">
          {passCount}/3
        </span>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-[11px] text-muted"
          >
            {open ? (
              <ChevronDown className="mr-1 size-3" />
            ) : (
              <ChevronRight className="mr-1 size-3" />
            )}
            {open ? "Hide" : "Show"} judge reasoning
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 space-y-2 border-l-2 border-neutral-200 pl-3 dark:border-neutral-800">
            {checks.map((c) => (
              <li key={c.key} className="text-xs">
                <div className="flex items-center gap-1.5">
                  <CheckDot pass={c.check.pass} />
                  <strong className="font-semibold">{c.label}</strong>
                </div>
                <p className="mt-0.5 pl-5 leading-snug text-neutral-600 dark:text-neutral-400">
                  {c.check.reason || "(no reason provided)"}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-1.5 pl-5 text-[10px] text-muted">
            <Badge variant="outline" className="font-mono">
              model: {adjudication.model}
            </Badge>
            <Badge variant="outline" className="font-mono">
              cost: ${adjudication.cost_estimate.toFixed(5)}
            </Badge>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function CheckDot({ pass }: { pass: boolean }) {
  if (pass) {
    return (
      <span
        aria-label="pass"
        className="inline-flex size-3.5 items-center justify-center border-[1.5px] border-emerald-600 bg-emerald-100 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-300"
      >
        <Check className="size-2.5" />
      </span>
    );
  }
  return (
    <span
      aria-label="fail"
      className="inline-flex size-3.5 items-center justify-center border-[1.5px] border-red-600 bg-red-100 text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-300"
    >
      <X className="size-2.5" />
    </span>
  );
}
