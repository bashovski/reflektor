import { resolveTheme } from "@pierre/diffs";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { BundledTheme } from "shiki/themes";
import { codeThemeFor, DEFAULT_CODE_THEME, HIGHLIGHTER, type ThemeMode } from "./themes";

// What the reviewer set for themselves. It lives in this browser's localStorage, so every report
// page, the setup page and the inbox agree. The inbox (daemon.mjs) and index.html read
// pr-report:theme before the first paint, so that key keeps its name.

export type ThemeChoice = "system" | "light" | "dark";
export type DiffStyle = "unified" | "split";

export const PREF_KEYS = {
  theme: "pr-report:theme",
  diffStyle: "pr-report:diff-style",
  codeThemeDark: "pr-report:code-theme-dark",
  codeThemeLight: "pr-report:code-theme-light",
} as const;

export const storage = {
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

export type Preferences = {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  // The mode on screen: the choice, or the OS setting for "system".
  resolvedTheme: ThemeMode;
  diffStyle: DiffStyle;
  setDiffStyle: (s: DiffStyle) => void;
  // One code theme per mode: the pick, for pickers, and the same pair once both themes are loaded,
  // for the diff renderer, which switches between them with resolvedTheme.
  codeTheme: Record<ThemeMode, BundledTheme>;
  renderTheme: Record<ThemeMode, BundledTheme>;
  setCodeTheme: (mode: ThemeMode, id: BundledTheme) => void;
};

const Ctx = createContext<Preferences | null>(null);

export const usePrefs = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("usePrefs outside provider");
  return value;
};

export const PreferencesProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setThemeState] = useState<ThemeChoice>(() => storage.get(PREF_KEYS.theme, "system"));
  const systemDark = useSystemDark();
  const resolvedTheme: ThemeMode = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    storage.set(PREF_KEYS.theme, t);
  }, []);

  const [diffStyle, setDiffStyleState] = useState<DiffStyle>(() => storage.get(PREF_KEYS.diffStyle, "unified"));
  const setDiffStyle = useCallback((s: DiffStyle) => {
    setDiffStyleState(s);
    storage.set(PREF_KEYS.diffStyle, s);
  }, []);

  const [codeTheme, setCodeThemeState] = useState<Record<ThemeMode, BundledTheme>>(() => ({
    dark: codeThemeFor("dark", storage.get(PREF_KEYS.codeThemeDark, null)),
    light: codeThemeFor("light", storage.get(PREF_KEYS.codeThemeLight, null)),
  }));
  const setCodeTheme = useCallback((mode: ThemeMode, id: BundledTheme) => {
    setCodeThemeState((prev) => ({ ...prev, [mode]: id }));
    storage.set(mode === "dark" ? PREF_KEYS.codeThemeDark : PREF_KEYS.codeThemeLight, id);
  }, []);

  // The renderer only ever gets themes that are loaded: asked for one it has not loaded, it logs an
  // error and draws again once the theme arrives. The defaults ship with the renderer, so they are
  // the starting point; the picked pair takes over as soon as both of its themes are in.
  const [renderTheme, setRenderTheme] = useState<Record<ThemeMode, BundledTheme>>(DEFAULT_CODE_THEME);
  useEffect(() => {
    let stale = false;
    const apply = () => {
      if (!stale) setRenderTheme(codeTheme);
    };
    // When a theme cannot load (offline, a chunk missing), the renderer gets it anyway and says so itself.
    Promise.all([resolveTheme(codeTheme.dark, HIGHLIGHTER), resolveTheme(codeTheme.light, HIGHLIGHTER)]).then(apply, apply);
    return () => {
      stale = true;
    };
  }, [codeTheme]);

  const value = useMemo<Preferences>(
    () => ({ theme, setTheme, resolvedTheme, diffStyle, setDiffStyle, codeTheme, renderTheme, setCodeTheme }),
    [theme, setTheme, resolvedTheme, diffStyle, setDiffStyle, codeTheme, renderTheme, setCodeTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
