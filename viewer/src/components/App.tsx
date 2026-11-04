import { TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bundle } from "../../../skill/schema/types";
import { ReportProvider, useReport } from "../lib/state";
import { BeforeMerge } from "./BeforeMerge";
import { Coverage } from "./Coverage";
import { FileModal } from "./FileModal";
import { Flows } from "./Flows";
import { Hero, TopBar } from "./Header";
import { Sections } from "./Sections";
import { Sidebar } from "./Sidebar";

const SHORTCUTS = [
  ["j", "Next file"],
  ["k", "Previous file"],
  ["v", "Mark the current file as viewed"],
  ["o", "Open or close the current file"],
  ["f", "Show the current file in full"],
  ["?", "Show this help"],
] as const;

const HelpDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="surface m-auto w-[min(380px,92vw)] rounded-xl border p-5 text-[var(--text)] shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Keyboard shortcuts</h2>
        <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-500/10">
          <X className="size-4" />
        </button>
      </div>
      <ul className="space-y-2 text-sm">
        {SHORTCUTS.map(([key, label]) => (
          <li key={key} className="flex items-center gap-3">
            <kbd className="inline-flex min-w-6 justify-center rounded border border-[var(--border)] bg-zinc-500/10 px-1.5 font-mono text-xs">{key}</kbd>
            {label}
          </li>
        ))}
      </ul>
    </dialog>
  );
};

const useShortcuts = (onHelp: () => void) => {
  const { orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal } = useReport();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || modal) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;

      const index = current ? orderedFiles.indexOf(current) : -1;
      const go = (i: number) => {
        const path = orderedFiles[Math.max(0, Math.min(orderedFiles.length - 1, i))];
        if (path) jumpTo({ path });
      };

      if (e.key === "j") go(index + 1);
      else if (e.key === "k") go(index - 1);
      else if (e.key === "v" && current) {
        toggleViewed(current);
        go(index + 1);
      } else if (e.key === "o" && current) setFileOpen(current, !isFileOpen(current));
      else if (e.key === "f" && current) openModal({ path: current });
      else if (e.key === "?") onHelp();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal, onHelp]);
};

const Warnings = () => {
  const { bundle } = useReport();
  if (!bundle.warnings.length) return null;
  return (
    <details className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm text-zinc-500">
      <summary className="flex cursor-pointer items-center gap-2">
        <TriangleAlert className="size-4 text-amber-500" />
        {bundle.warnings.length} build warnings
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
        {bundle.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
};

const Layout = () => {
  const [help, setHelp] = useState(false);
  useShortcuts(() => setHelp(true));
  const { bundle } = useReport();

  useEffect(() => {
    document.title = `${bundle.report.tag} ${bundle.report.title}`;
  }, [bundle]);

  return (
    <>
      <TopBar onHelp={() => setHelp(true)} />
      <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <Sidebar />
        </aside>
        <main className="min-w-0 space-y-10">
          <Hero />
          <BeforeMerge />
          <Flows />
          <Sections />
          <Coverage />
          <Warnings />
          <footer className="pb-10 text-xs text-zinc-400">
            Code comes straight from git. Notes, highlights and flows were written by Claude and may be wrong. Built{" "}
            {new Date(bundle.builtAt).toLocaleString()}.
          </footer>
        </main>
      </div>
      <FileModal />
      <HelpDialog open={help} onClose={() => setHelp(false)} />
    </>
  );
};

export const App = ({ bundle }: { bundle: Bundle }) => (
  <ReportProvider bundle={bundle}>
    <Layout />
  </ReportProvider>
);
