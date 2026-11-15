import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Bundle } from "../../../skill/schema/types";
import { useAgent } from "../lib/agent";
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
import { HelpDialog } from "./Help";
import { PlanCheck } from "./PlanCheck";
import { PreviousReview } from "./PreviousReview";
import { ProjectChecks } from "./ProjectChecks";
import { MergedBanner } from "./PullRequest";
import { ReviewBar } from "./ReviewBar";
import { RoundBanner } from "./RoundBanner";
import { Screenshots } from "./Screenshots";
import { Sections } from "./Sections";
import { SettingsPage } from "./Settings";
import { SetupBanner } from "./SetupBanner";
import { Sidebar } from "./Sidebar";

const useShortcuts = (onHelp: () => void, off: boolean) => {
  const { orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal, bundle } = useReport();
  const { openComposer, editable, submit, sent, mode } = useReview();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (off) return;
      const target = e.target as HTMLElement;
      const inField = Boolean(target.closest("input, textarea, select, [contenteditable]"));
      // Ctrl+Enter (Cmd+Enter on a Mac) sends the review, like the button in the bar. A comment box takes the same
      // keys to save its comment, so inside one the box wins.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !inField && !modal) {
        if (mode === "server" && !sent && !bundle.draft) {
          e.preventDefault();
          void submit();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || modal || inField || target.closest("dialog")) return;

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
  }, [orderedFiles, current, setCurrent, toggleViewed, isFileOpen, setFileOpen, jumpTo, openModal, modal, onHelp, openComposer, editable, submit, sent, mode, bundle.draft, off]);
};

const Warnings = () => {
  const { bundle } = useReport();
  if (!bundle.warnings.length) return null;
  return (
    <details className="border border-[var(--border)] px-4 py-3 text-sm text-muted">
      <summary className="flex cursor-pointer items-center gap-2">
        <TriangleAlert className="size-4 text-warn-500" />
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

// Settings opens as a page in place of the review, at #settings, so the browser's Back button leaves it too. The
// review stays mounted underneath, hidden, and comes back where the reader left it.
const useSettingsView = () => {
  const [open, setOpen] = useState(() => window.location.hash === "#settings");
  const pushed = useRef(false);
  const scroll = useRef(0);

  useEffect(() => {
    const sync = () => setOpen(window.location.hash === "#settings");
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  useEffect(() => {
    if (open) return;
    const top = scroll.current;
    requestAnimationFrame(() => window.scrollTo({ top }));
  }, [open]);

  const show = useCallback(() => {
    if (window.location.hash === "#settings") return;
    scroll.current = window.scrollY;
    pushed.current = true;
    window.location.hash = "settings";
  }, []);

  const hide = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    setOpen(false);
  }, []);

  return { open, show, hide };
};

const Layout = () => {
  const settings = useSettingsView();
  const [help, setHelp] = useState(false);
  useShortcuts(settings.show, settings.open);
  const { bundle } = useReport();
  const agent = useAgent();
  useTab(settings.open);

  return (
    <>
      <TopBar onSettings={settings.show} onHelp={() => setHelp(true)} />
      {settings.open && <SettingsPage topBar={null} back={{ label: "Back to the review", onClick: settings.hide }} />}
      <div hidden={settings.open}>
        <SetupBanner />
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
            <Screenshots />
            <Contracts />
            <Sections />
            <Coverage />
            <Warnings />
            <footer className="pb-24 text-xs text-faint">
              Code comes straight from git. Notes, highlights and flows were written by {agent.name} and may be wrong. Built{" "}
              {new Date(bundle.builtAt).toLocaleString()}.
            </footer>
          </WindowVirtualizer>
        </div>
        <ReviewBar />
      </div>
      <FileModal />
      <HelpDialog open={help} onClose={() => setHelp(false)} />
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
