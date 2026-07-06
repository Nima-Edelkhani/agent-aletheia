import { QuestionForm } from "./components/QuestionForm";
import {
  KnowledgeBaseProvider,
  KnowledgeBaseSidebar,
  KnowledgeBaseTrigger,
} from "./components/KnowledgeBase";
import { ModeToggle } from "@/components/mode-toggle";
import { AletheiaMark } from "@/components/aletheia-mark";
import { SectionMarker } from "@/components/section-marker";

const BANNER = ` █████╗ ██╗     ███████╗████████╗██╗  ██╗███████╗██╗ █████╗
██╔══██╗██║     ██╔════╝╚══██╔══╝██║  ██║██╔════╝██║██╔══██╗
███████║██║     █████╗     ██║   ███████║█████╗  ██║███████║
██╔══██║██║     ██╔══╝     ██║   ██╔══██║██╔══╝  ██║██╔══██║
██║  ██║███████╗███████╗   ██║   ██║  ██║███████╗██║██║  ██║
╚═╝  ╚═╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝`;

export default function Page() {
  return (
    <KnowledgeBaseProvider>
      <main className="mx-auto max-w-5xl px-6 py-6 lg:py-10">
        {/* ═══ TOP ROW ═══════════════════════════════════════════════ */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AletheiaMark className="h-6 w-auto text-ink" />
            <KnowledgeBaseTrigger />
          </div>
          <ModeToggle />
        </div>

      {/* ═══ MASTHEAD ═══════════════════════════════════════════════ */}
      <header className="pb-8 pt-2 md:pb-10">
        <h1 className="sr-only">Aletheia</h1>
        <pre
          aria-hidden="true"
          className="overflow-x-auto whitespace-pre font-mono font-bold leading-[1.05] text-ink text-[0.58rem] sm:text-[0.85rem] md:text-[1.15rem] lg:text-[1.5rem]"
        >{BANNER}</pre>

        <p className="mt-6 max-w-2xl font-sans text-base leading-snug md:text-lg">
          <span className="mr-1 inline-block font-bold">→</span>
          A <mark className="bg-accent px-0.5 font-bold">verifiable</mark>{" "}
          knowledge-base explorer. Every claim in every answer traces back to
          a specific quote in a specific document — verified against the
          source.
        </p>
      </header>

      {/* ═══ § 01 · INQUIRY ═════════════════════════════════════════ */}
      <section className="inquiry-frame mt-10">
        <SectionMarker n="01" label="Inquiry" />
        <div className="mt-6">
          <QuestionForm />
        </div>
      </section>

        {/* ═══ COLOPHON ══════════════════════════════════════════════ */}
        <footer className="mt-20 border-t-[3px] border-ink pt-3 text-left font-mono text-[10px] font-bold uppercase tracking-[0.22em]">
          Created and open-sourced by Nima Edelkhani · 2026
        </footer>
      </main>
      <KnowledgeBaseSidebar />
    </KnowledgeBaseProvider>
  );
}


