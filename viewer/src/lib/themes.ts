import { canUseWASM } from "@pierre/diffs";
import { type BundledTheme, bundledThemesInfo } from "shiki/themes";

// Highlights colors code with WebAssembly lexers, several times faster than Shiki's regex engine.
export const HIGHLIGHTER = canUseWASM() ? "highlights" : "shiki-js";

export type ThemeMode = "dark" | "light";
export type CodeTheme = { id: BundledTheme; name: string; mode: ThemeMode };

// Every code theme Shiki ships, with the mode each one was drawn for. The diff library loads a theme
// in its own chunk the first time a page uses it, so the list costs nothing until a theme is picked.
export const CODE_THEMES: CodeTheme[] = bundledThemesInfo
  .map((t) => ({ id: t.id as BundledTheme, name: t.displayName, mode: t.type }))
  .sort((a, b) => a.name.localeCompare(b.name));

// One Dark Pro and its Atom sibling One Light: what the page used before there was a picker.
export const DEFAULT_CODE_THEME: Record<ThemeMode, BundledTheme> = { dark: "one-dark-pro", light: "one-light" };

export const codeThemesFor = (mode: ThemeMode) => CODE_THEMES.filter((t) => t.mode === mode);

// A stored value counts only when it names a theme drawn for that mode, so a light theme never serves
// dark mode after a hand edit to localStorage, and a theme Shiki dropped falls back to the default.
export const codeThemeFor = (mode: ThemeMode, id: unknown): BundledTheme =>
  CODE_THEMES.some((t) => t.id === id && t.mode === mode) ? (id as BundledTheme) : DEFAULT_CODE_THEME[mode];
