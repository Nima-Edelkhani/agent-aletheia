"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getDocListReport } from "../actions";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronLeft, ChevronRight, Database } from "lucide-react";

interface DocMeta {
  id: string;
  metadata: Record<string, unknown>;
}

interface Skipped {
  file: string;
  reason: string;
}

interface Ctx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  docs: DocMeta[] | null;
  skipped: Skipped[];
  error: string | null;
}

const KnowledgeBaseCtx = createContext<Ctx | null>(null);
const STORAGE_KEY = "aletheia:kb-panel-open";

/* ─── Provider ────────────────────────────────────────────────────── */

export function KnowledgeBaseProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "true") setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      /* ignore */
    }
  }, [mounted, open]);

  useEffect(() => {
    let cancelled = false;
    getDocListReport()
      .then((report) => {
        if (cancelled) return;
        setDocs(report.docs as DocMeta[]);
        setSkipped(report.skipped);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value: Ctx = {
    open,
    setOpen,
    toggle: () => setOpen(!open),
    docs,
    skipped,
    error,
  };

  return (
    <KnowledgeBaseCtx.Provider value={value}>
      {children}
    </KnowledgeBaseCtx.Provider>
  );
}

function useKb(): Ctx {
  const ctx = useContext(KnowledgeBaseCtx);
  if (!ctx) {
    throw new Error(
      "KnowledgeBaseTrigger / KnowledgeBaseSidebar must be rendered inside KnowledgeBaseProvider",
    );
  }
  return ctx;
}

/* ─── Trigger (navbar chip) ───────────────────────────────────────── */

export function KnowledgeBaseTrigger() {
  const { open, toggle, docs } = useKb();
  return (
    <button
      type="button"
      onClick={toggle}
      className="kb-chip flex items-center gap-1.5 border-2 border-ink bg-paper px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-ink shadow-[3px_3px_0_0_hsl(var(--ink))] transition-transform hover:bg-accent"
      aria-expanded={open}
      aria-controls="knowledge-base-sidebar"
      aria-label={open ? "Hide knowledge base" : "Show knowledge base"}
    >
      <Database className="size-3" />
      <span>KB</span>
      {docs && <span className="text-muted">· {docs.length}</span>}
      <ChevronRight
        className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

/* ─── Sidebar (fixed panel) ───────────────────────────────────────── */

export function KnowledgeBaseSidebar() {
  const { open, setOpen, docs, skipped, error } = useKb();

  if (!open) return null;

  return (
    <aside
      id="knowledge-base-sidebar"
      className="fixed left-2 top-2 z-30 w-64 border-2 border-ink bg-paper shadow-[5px_5px_0_0_hsl(var(--ink))]"
      aria-label="Knowledge base document index"
    >
      <header className="flex items-center justify-between border-b-2 border-ink px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink">
          <Database className="size-3" />
          <span>Knowledge base</span>
          {docs && (
            <span
              className="border border-ink bg-accent px-1 text-[9px]"
              style={{ color: "#0a0a0a" }}
            >
              {docs.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted hover:text-ink"
          aria-label="Hide knowledge base panel"
        >
          <ChevronLeft className="size-4" />
        </button>
      </header>

      <ScrollArea className="max-h-[60vh]">
        <div className="space-y-0.5 px-3 py-2">
          {error && (
            <p className="font-mono text-[11px] text-red-600 dark:text-red-400">
              Error: {error}
            </p>
          )}
          {!docs && !error && (
            <p className="font-mono text-[11px] text-muted">loading…</p>
          )}
          {docs && docs.length === 0 && !error && (
            <p className="font-mono text-[11px] text-muted">
              Knowledge base is empty. Drop <code>.json</code>,{" "}
              <code>.md</code>, <code>.txt</code>, or <code>.xml</code> docs
              into <code>knowledge-base/</code>.
            </p>
          )}
          {docs?.map((d) => (
            <div
              key={d.id}
              title={d.id}
              className="truncate font-mono text-[11px] leading-tight text-neutral-700 dark:text-neutral-300"
            >
              <span className="text-muted">·</span> {d.id}
            </div>
          ))}
        </div>
      </ScrollArea>

      {skipped.length > 0 && (
        <div className="border-t-2 border-ink px-3 py-2 font-mono text-[10px] text-muted">
          <div className="mb-1 font-bold uppercase tracking-widest">
            {skipped.length} skipped
          </div>
          <ul className="space-y-0.5">
            {skipped.slice(0, 5).map((s) => (
              <li
                key={s.file}
                title={`${s.file} — ${s.reason}`}
                className="truncate"
              >
                <span className="text-muted">×</span> {s.file}
              </li>
            ))}
            {skipped.length > 5 && (
              <li className="text-muted">…and {skipped.length - 5} more</li>
            )}
          </ul>
        </div>
      )}
    </aside>
  );
}
