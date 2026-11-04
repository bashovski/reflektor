import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Bundle, DiffFile, Ref } from "../../../skill/schema/types";

export type ThemeChoice = "system" | "light" | "dark";
export type DiffStyle = "unified" | "split";
export type Focus = { path: string; line?: number; side?: "new" | "old"; at: number };
export type ModalTarget = { path: string; line?: number; side?: "new" | "old" };

type ReportState = {
  bundle: Bundle;
  filesByPath: Map<string, DiffFile>;
  sectionOfFile: Map<string, number>;
  orderedFiles: string[];
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  resolvedTheme: "light" | "dark";
  diffStyle: DiffStyle;
  setDiffStyle: (s: DiffStyle) => void;
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

const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be blocked for file:// pages; state then lasts for this tab only.
    }
  },
};

const useSystemDark = () => {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
};

export const ReportProvider = ({ bundle, children }: { bundle: Bundle; children: ReactNode }) => {
  const repoKey = `pr-report:${bundle.diff.repo.owner ?? ""}/${bundle.diff.repo.name}`;

  const filesByPath = useMemo(() => new Map(bundle.diff.files.map((f) => [f.path, f])), [bundle]);
  const hashes = useMemo(() => new Map(bundle.diff.files.map((f) => [f.path, contentHash(f)])), [bundle]);

  const { sectionOfFile, orderedFiles } = useMemo(() => {
    const map = new Map<string, number>();
    const order: string[] = [];
    bundle.report.sections.forEach((s, i) =>
      s.files.forEach((f) => {
        map.set(f.path, i);
        order.push(f.path);
      }),
    );
    return { sectionOfFile: map, orderedFiles: order };
  }, [bundle]);

  const [theme, setThemeState] = useState<ThemeChoice>(() => storage.get("pr-report:theme", "system"));
  const systemDark = useSystemDark();
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    storage.set("pr-report:theme", t);
  }, []);

  const [diffStyle, setDiffStyleState] = useState<DiffStyle>(() => storage.get("pr-report:diff-style", "unified"));
  const setDiffStyle = useCallback((s: DiffStyle) => {
    setDiffStyleState(s);
    storage.set("pr-report:diff-style", s);
  }, []);

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

  const [sectionOpen, setSectionOpenMap] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(bundle.report.sections.map((s, i) => [i, s.review === "must"])),
  );
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
        openModal({ path: ref.path, line: ref.line, side: ref.side });
        return;
      }
      setSectionOpen(sectionIndex, true);
      setFileOpen(ref.path, true);
      setCurrent(ref.path);
      setFocus({ path: ref.path, line: ref.line, side: ref.side, at: Date.now() });
    },
    [sectionOfFile, setSectionOpen, setFileOpen],
  );

  useEffect(() => {
    if (!focus) return;
    const id = window.setTimeout(() => {
      const el = document.getElementById(fileDomId(focus.path));
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }, 60);
    return () => window.clearTimeout(id);
  }, [focus]);

  const value: ReportState = {
    bundle,
    filesByPath,
    sectionOfFile,
    orderedFiles,
    theme,
    setTheme,
    resolvedTheme,
    diffStyle,
    setDiffStyle,
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
