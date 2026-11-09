import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Bundle } from "../../../skill/schema/types";
import { ReviewProvider, useReview } from "../lib/review";
import { ReportProvider, useReport } from "../lib/state";
import { useTab } from "../lib/tab";
import { BeforeMerge } from "./BeforeMerge";
import { Contracts } from "./Contracts";
import { DriftBanner } from "./DriftBanner";
import { Coverage } from "./Coverage";
import { FileModal } from "./FileModal";
import { Findings } from "./Findings";
import { Flows } from "./Flows";
import { Hero, TopBar } from "./Header";
import { PlanCheck } from "./PlanCheck";
import { PreviousReview } from "./PreviousReview";
import { ProjectChecks } from "./ProjectChecks";
import { MergedBanner } from "./PullRequest";
import { ReviewBar } from "./ReviewBar";
import { RoundBanner } from "./RoundBanner";
import { Sections } from "./Sections";
import { SettingsDialog } from "./Settings";
import { Sidebar } from "./Sidebar";

const useShortcuts = (onHelp: () => void) => {
  const { orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal } = useReport();
  const { openComposer, editable } = useReview();

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
      else if (e.key === "c" && current && editable) {
        setFileOpen(current, true);
        openComposer({ type: "file", path: current });
      }
      else if (e.key === "?") onHelp();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal, onHelp, openComposer, editable]);
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

// Diffs render only the lines near the screen. Pierre's virtualizer follows the page's own scroll,
// so long reports keep the normal scrollbar, find-in-page for what is rendered, and sticky headers.
const WindowVirtualizer = ({ children }: { children: ReactNode }) => {
  const [virtualizer] = useState(() => new Virtualizer());
  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (node) virtualizer.setup(document);
      else virtualizer.cleanUp();
    },
    [virtualizer],
  );
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <main ref={ref} className="min-w-0 space-y-10">
        {children}
      </main>
    </VirtualizerContext.Provider>
  );
};

const Layout = () => {
  const [settings, setSettings] = useState(false);
  useShortcuts(() => setSettings(true));
  const { bundle } = useReport();
  useTab();

  return (
    <>
      <TopBar onSettings={() => setSettings(true)} />
      <RoundBanner />
      <MergedBanner />
      <DriftBanner />
      <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <Sidebar />
        </aside>
        <WindowVirtualizer>
          <Hero />
          <PreviousReview />
          <PlanCheck />
          <BeforeMerge />
          <ProjectChecks />
          <Findings />
          <Flows />
          <Contracts />
          <Sections />
          <Coverage />
          <Warnings />
          <footer className="pb-24 text-xs text-zinc-400">
            Code comes straight from git. Notes, highlights and flows were written by Claude and may be wrong. Built{" "}
            {new Date(bundle.builtAt).toLocaleString()}.
          </footer>
        </WindowVirtualizer>
      </div>
      <ReviewBar />
      <FileModal />
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </>
  );
};

export const App = ({ bundle }: { bundle: Bundle }) => (
  <ReportProvider bundle={bundle}>
    <ReviewProvider bundle={bundle}>
      <Layout />
    </ReviewProvider>
  </ReportProvider>
);
