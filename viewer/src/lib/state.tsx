import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Bundle, DiffFile, Ref, Section } from "../../../skill/schema/types";
import { scrollBehavior } from "./motion";
import { type Preferences, storage, usePrefs } from "./prefs";

export type { DiffStyle, ThemeChoice } from "./prefs";
export type Focus = { path: string; line?: number; side?: "new" | "old"; at: number };
export type ModalTarget = { path: string; line?: number; side?: "new" | "old" };
// "branch": the whole branch against its base. "round": only what changed since the round the
// reviewer sent, each file against its version in that round.
export type DiffView = "branch" | "round";
// A section as the current view shows it. `index` is its place in report.sections; the extra group
// for files whose change was undone since the round gets the index after the last section.
export type ShownSection = { section: Section; index: number; paths: string[] };

// The report's state, plus the reviewer's preferences (theme, diff style, code theme) from lib/prefs.
type ReportState = Preferences & {
  bundle: Bundle;
  // The files of the current view, and of the whole branch.
  filesByPath: Map<string, DiffFile>;
  branchFiles: Map<string, DiffFile>;
  sectionOfFile: Map<string, number>;
  orderedFiles: string[];
  view: DiffView;
  setView: (v: DiffView) => void;
  // The round the "round" view compares with, and the paths that changed since; null without one.
  sinceRound: { round: number; paths: Set<string> } | null;
  shownSections: ShownSection[];
  isViewed: (path: string) => boolean;
  toggleViewed: (path: string) => void;
  viewedCount: number;
  isSectionOpen: (index: number) => boolean;
  setSectionOpen: (index: number, open: boolean) => void;
  isFileOpen: (path: string) => boolean;
  setFileOpen: (path: string, open: boolean) => void;
  current: string | null;
  setCurrent: (path: string | null) => void;
  focus: Focus | null;
  jumpTo: (ref: Ref) => void;
  modal: ModalTarget | null;
  openModal: (target: ModalTarget | null) => void;
};

const Ctx = createContext<ReportState | null>(null);

export const useReport = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("useReport outside provider");
  return value;
};

export const fileDomId = (path: string) => `file-${path.replace(/[^\w-]+/g, "-")}`;
export const sectionDomId = (index: number) => `section-${index}`;

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const contentHash = (file: DiffFile) => fnv1a(`${file.oldContent ?? ""}\u0000${file.newContent ?? ""}\u0000${file.status}`);

export const ReportProvider = ({ bundle, children }: { bundle: Bundle; children: ReactNode }) => {
  const repoKey = `reflektor:${bundle.diff.repo.owner ?? ""}/${bundle.diff.repo.name}`;
  const prefs = usePrefs();

  const branchFiles = useMemo(() => new Map(bundle.diff.files.map((f) => [f.path, f])), [bundle]);
  const roundFiles = useMemo(() => new Map((bundle.diff.sinceRound?.files ?? []).map((f) => [f.path, f])), [bundle]);
  const sinceRound = useMemo(
    () => (bundle.diff.sinceRound ? { round: bundle.diff.sinceRound.round, paths: new Set(roundFiles.keys()) } : null),
    [bundle, roundFiles],
  );
  // A later round opens on what changed since the reviewer sent the last one.
  const [view, setView] = useState<DiffView>(() => (roundFiles.size ? "round" : "branch"));
  const filesByPath = view === "round" ? roundFiles : branchFiles;
  // Viewed marks follow the whole-branch version, so a file changed since a round shows up as not viewed.
  const hashes = useMemo(
    () => new Map([...roundFiles.values(), ...branchFiles.values()].map((f) => [f.path, contentHash(f)])),
    [branchFiles, roundFiles],
  );

  const { sectionOfFile, orderedFiles, shownSections } = useMemo(() => {
    const map = new Map<string, number>();
    const order: string[] = [];
    const shown: ShownSection[] = [];
    const sections = bundle.report.sections;
    sections.forEach((section, index) => {
      const paths = section.files.map((f) => f.path).filter((p) => filesByPath.has(p));
      if (!paths.length) return;
      shown.push({ section, index, paths });
      for (const p of paths) {
        map.set(p, index);
        order.push(p);
      }
    });
    // Changed since the round but no longer part of the branch: the change was undone.
    const undone = view === "round" ? [...roundFiles.keys()].filter((p) => !map.has(p)) : [];
    if (undone.length) {
      const section: Section = {
        kind: "other",
        title: "Undone since that round",
        review: "skim",
        reason: "These files are back to their base version, so the branch no longer changes them.",
        highlights: [],
        questions: [],
        files: undone.map((path) => ({ path, note: "" })),
      };
      shown.push({ section, index: sections.length, paths: undone });
      for (const p of undone) {
        map.set(p, sections.length);
        order.push(p);
      }
    }
    return { sectionOfFile: map, orderedFiles: order, shownSections: shown };
  }, [bundle, filesByPath, roundFiles, view]);

  const [viewedMap, setViewedMap] = useState<Record<string, string>>(() => storage.get(`${repoKey}:viewed`, {}));
  const isViewed = useCallback((path: string) => viewedMap[path] !== undefined && viewedMap[path] === hashes.get(path), [viewedMap, hashes]);
  const [fileOpen, setFileOpenMap] = useState<Record<string, boolean>>({});

  const toggleViewed = useCallback(
    (path: string) => {
      setViewedMap((prev) => {
        const next = { ...prev };
        if (next[path] === hashes.get(path)) delete next[path];
        else next[path] = hashes.get(path)!;
        storage.set(`${repoKey}:viewed`, next);
        return next;
      });
      setFileOpenMap((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    },
    [hashes, repoKey],
  );
  const viewedCount = useMemo(() => bundle.diff.files.filter((f) => isViewed(f.path)).length, [bundle, isViewed]);

  // Every section starts collapsed; the sidebar, links and j/k open the one they go to.
  const [sectionOpen, setSectionOpenMap] = useState<Record<number, boolean>>({});
  const isSectionOpen = useCallback((i: number) => sectionOpen[i] ?? false, [sectionOpen]);
  const setSectionOpen = useCallback((i: number, open: boolean) => setSectionOpenMap((p) => ({ ...p, [i]: open })), []);

  const isFileOpen = useCallback(
    (path: string) => {
      if (fileOpen[path] !== undefined) return fileOpen[path];
      const file = filesByPath.get(path);
      const section = bundle.report.sections[sectionOfFile.get(path) ?? -1];
      return !isViewed(path) && !file?.generated && section?.review !== "skip";
    },
    [fileOpen, filesByPath, bundle, sectionOfFile, isViewed],
  );
  const setFileOpen = useCallback((path: string, open: boolean) => setFileOpenMap((p) => ({ ...p, [path]: open })), []);

  const [current, setCurrent] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [modal, openModal] = useState<ModalTarget | null>(null);

  const jumpTo = useCallback(
    (ref: Ref) => {
      const sectionIndex = sectionOfFile.get(ref.path);
      if (sectionIndex === undefined) {
        // Not in this view, but in the branch: show the whole branch there.
        if (view === "round" && branchFiles.has(ref.path)) {
          setView("branch");
          window.setTimeout(() => {
            setFileOpen(ref.path, true);
            setCurrent(ref.path);
            setFocus({ path: ref.path, line: ref.line, side: ref.side, at: Date.now() });
          }, 0);
          const index = bundle.report.sections.findIndex((s) => s.files.some((f) => f.path === ref.path));
          if (index >= 0) setSectionOpen(index, true);
          return;
        }
        openModal({ path: ref.path, line: ref.line, side: ref.side });
        return;
      }
      setSectionOpen(sectionIndex, true);
      setFileOpen(ref.path, true);
      setCurrent(ref.path);
      setFocus({ path: ref.path, line: ref.line, side: ref.side, at: Date.now() });
    },
    [sectionOfFile, setSectionOpen, setFileOpen, view, branchFiles, bundle],
  );

  useEffect(() => {
    if (!focus) return;
    const id = window.setTimeout(() => {
      const el = document.getElementById(fileDomId(focus.path));
      if (!el) return;
      el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }, 60);
    return () => window.clearTimeout(id);
  }, [focus]);

  const value: ReportState = {
    ...prefs,
    bundle,
    filesByPath,
    branchFiles,
    sectionOfFile,
    orderedFiles,
    view,
    setView,
    sinceRound,
    shownSections,
    isViewed,
    toggleViewed,
    viewedCount,
    isSectionOpen,
    setSectionOpen,
    isFileOpen,
    setFileOpen,
    current,
    setCurrent,
    focus,
    jumpTo,
    modal,
    openModal,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
