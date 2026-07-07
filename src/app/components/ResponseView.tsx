"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AskResult } from "../actions";
import { SignalCard } from "./SignalCard";
import { SectionMarker } from "@/components/section-marker";
import { citationsToMarkdownLinks } from "@core/citations";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Coins,
  Timer,
  AlertTriangle,
} from "lucide-react";

export function ResponseView({ result }: { result: AskResult }) {
  const r = result.response.response;
  const [showScope, setShowScope] = useState(false);
  const [showNoSignal, setShowNoSignal] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const contributingSignals = r.signals.filter((s) => s.signal_type === "signal");
  const noSignalSignals = r.signals.filter((s) => s.signal_type === "no-signal");
  // Dropped signals live on the trace — kept out of response.signals.
  // Visualized here for transparency.
  const droppedEntries = result.trace.dropped_signals.filter(
    (d) => d.signal.signal_type === "signal",
  );
  const thresholds = {
    ref_fuzzy_distance_cutoff:
      result.trace.thresholds_applied.ref_fuzzy_distance_cutoff,
    confidence_cutoff: result.trace.thresholds_applied.confidence_cutoff,
  };

  return (
    <div className="space-y-6">
      {/* SCOPE SUMMARY */}
      <Collapsible open={showScope} onOpenChange={setShowScope}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-sm text-muted">
            {showScope ? (
              <ChevronDown className="mr-1 size-3" />
            ) : (
              <ChevronRight className="mr-1 size-3" />
            )}
            <strong className="mr-1">{r.scope_of_exploration.length}</strong>
            document{r.scope_of_exploration.length === 1 ? "" : "s"} considered
            relevant and examined
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 ml-6 space-y-1 text-sm">
            {r.scope_of_exploration.map((id) => (
              <li key={id} className="font-mono text-neutral-600">
                • {id}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {/* ANSWER */}
      <div>
        <SectionMarker n="02" label="Answer" />
      </div>
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="prose-answer text-sm leading-relaxed text-ink">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...props }) => {
                  if (href?.startsWith("#signal-")) {
                    const idx = href.replace("#signal-", "");
                    // Rely on native anchor navigation: sets location.hash
                    // (so :target re-evaluates to the correct card) and lets
                    // CSS `scroll-behavior: smooth` handle the scroll.
                    return (
                      <a
                        href={href}
                        className="cite-chip"
                        title={`Jump to signal ${idx}`}
                      >
                        {children}
                      </a>
                    );
                  }
                  return (
                    <a href={href} {...props}>
                      {children}
                    </a>
                  );
                },
              }}
            >
              {citationsToMarkdownLinks(r.response_text)}
            </ReactMarkdown>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
            <span>
              Answer based on <strong>{contributingSignals.length}</strong> signal
              {contributingSignals.length === 1 ? "" : "s"}
            </span>
            {droppedEntries.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDropped((v) => !v)}
                className="underline hover:text-ink"
              >
                <span className="text-red-600 dark:text-red-400">
                  {droppedEntries.length} dropped
                </span>{" "}
                — {showDropped ? "hide" : "show"}
              </button>
            )}
            {noSignalSignals.length > 0 && (
              <button
                type="button"
                onClick={() => setShowNoSignal((v) => !v)}
                className="underline hover:text-ink"
              >
                {noSignalSignals.length} no-signal —{" "}
                {showNoSignal ? "hide" : "show"}
              </button>
            )}
          </div>

          <Reasoning className="w-full" isStreaming={false}>
            <ReasoningTrigger />
            <ReasoningContent>{r.response_reasoning}</ReasoningContent>
          </Reasoning>

          {r.filtering_reasoning !== "No signals were filtered out." && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Filtering</AlertTitle>
              <AlertDescription>{r.filtering_reasoning}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* SIGNAL CARDS */}
      {(contributingSignals.length > 0 ||
        (showDropped && droppedEntries.length > 0) ||
        (showNoSignal && noSignalSignals.length > 0)) && (
        <section>
          <SectionMarker n="03" label="Signals" />
          <div className="mt-4 space-y-3">
            {contributingSignals.map((s, i) => (
              <SignalCard
                key={s.id}
                signal={s}
                index={i + 1}
                thresholds={thresholds}
              />
            ))}
            {showDropped &&
              droppedEntries.map((entry, i) => (
                <SignalCard
                  key={`dropped-${entry.signal.id}`}
                  signal={entry.signal}
                  index={contributingSignals.length + i + 1}
                  thresholds={thresholds}
                  droppedReason={entry.reason}
                />
              ))}
            {showNoSignal &&
              noSignalSignals.map((s, i) => (
                <SignalCard
                  key={s.id}
                  signal={s}
                  index={
                    contributingSignals.length +
                    (showDropped ? droppedEntries.length : 0) +
                    i +
                    1
                  }
                  thresholds={thresholds}
                />
              ))}
          </div>
        </section>
      )}

      {/* META + TRACE */}
      <div>
        <SectionMarker n="04" label="Performance" />
      </div>
      <Card className="!mt-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary" className="gap-1">
              <Coins className="size-3" />${r.cost_estimate.toFixed(4)}
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Timer className="size-3" />
              {(r.delay / 1000).toFixed(1)}s
            </Badge>
            <Badge variant="outline" className="gap-1">
              <BadgeCheck className="size-3" />
              {contributingSignals.length} signal(s)
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTrace((v) => !v)}
            className="text-xs"
          >
            {showTrace ? "hide" : "show"} trace
          </Button>
        </CardContent>
        {showTrace && (
          <CardContent className="pt-0">
            <ScrollArea className="max-h-96 w-full rounded-md border bg-neutral-50">
              <pre className="p-4 text-xs">
                {JSON.stringify(result.trace, null, 2)}
              </pre>
            </ScrollArea>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

