import { File as CodeFile, type FileOptions } from "@pierre/diffs/react";
import { ArrowLeft, Check, Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import type { BundledTheme } from "shiki/themes";
import { type ThemeChoice, usePrefs } from "../lib/prefs";
import { afterSetup, markSetupDone } from "../lib/setup";
import { codeThemesFor, HIGHLIGHTER, type ThemeMode } from "../lib/themes";
import Dither, { type DitherProps } from "../vendor/react-bits/Dither";
import { Choice } from "./Settings";
import { cx, Kbd } from "./ui";

// First-run setup, one screen per step. Enter moves on, Escape skips the rest, and every choice
// applies as soon as it is clicked, so the page itself shows what a choice does.

const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];

// What the code theme preview shows: a few lines of TypeScript with a comment, a string, a type
// and a call, so the main token colors of a theme are all on screen.
const SAMPLE = `import { readFile } from "node:fs/promises";

type Book = { isbn: string; title: string; ownerId: string };

export async function loadBooks(path: string): Promise<Book[]> {
  const text = await readFile(path, "utf8");
  const books: Book[] = JSON.parse(text);
  // One copy per owner: the same ISBN twice is a duplicate.
  const seen = new Set<string>();
  return books.filter((book) => {
    const key = \`\${book.ownerId}:\${book.isbn}\`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
`;

export type SetupStep = { id: string; title: string; next: string };

const Primary = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-2.5 rounded-control bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700"
  >
    {label}
    <Kbd name="Enter" className="h-[18px] min-w-[18px] border-white/25 bg-white/15 text-white shadow-none" />
  </button>
);

// The wizard's background: slow dithered waves (vendor/react-bits/Dither.tsx), with the settings picked in the
// React Bits playground. The cursor does nothing to it (strength 0, no ripple on a click), so it stays a background.
const BACKDROP = {
  ditherMode: "crosshatch",
  colorNum: 4,
  pixelSize: 2,
  waveSpeed: 0.05,
  waveFrequency: 2.1,
  waveAmplitude: 0.3,
  mouseEffect: "ripple",
  mouseRadius: 0.45,
  mouseStrength: 0,
  clickRipple: false,
} satisfies DitherProps;

// Its shades, from the one that fills most of the page to the crest of a wave. The palette replaces the component's
// wave and background colors, so those two are not set. There is one palette per theme because the wizard itself
// asks "Light or dark?" and the page must follow the answer: the dark one is the playground's, the light one is the
// same blues turned around to start from a light page.
const BACKDROP_PALETTE: Record<ThemeMode, string[]> = {
  dark: ["#06121f", "#173d5c", "#5f9ec7", "#e4f3ff"],
  light: ["#f3f8fc", "#d3e6f5", "#9cc4e4", "#5f9ec7"],
};

export const SetupFrame = ({
  steps,
  index,
  onBack,
  onNext,
  onSkip,
  children,
}: {
  steps: SetupStep[];
  index: number;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  children: ReactNode;
}) => {
  const step = steps[index];
  const { resolvedTheme } = usePrefs();
  return (
    <main className="relative isolate mx-auto flex min-h-screen w-full max-w-[860px] flex-col justify-center px-4 py-10 sm:px-6">
      {/* Fixed to the window and behind the wizard, out of reach of the pointer and of screen readers. `isolate` on
          the frame keeps the negative layer above the page's own background color. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <Dither {...BACKDROP} palette={BACKDROP_PALETTE[resolvedTheme]} />
      </div>
      {/* The label and the step marks get the card's surface, as a strip joined to its top: on the moving background
          itself, small text and the grey marks could not be read over a bright wave. */}
      <div className="surface flex items-center justify-between border border-b-0 px-6 py-3 text-xs text-muted sm:px-8">
        <span className="font-semibold tracking-tight text-[var(--text)]">pr-report</span>
        <span className="inline-flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {steps.map((s, i) => (
            <span key={s.id} className={cx("h-1.5 transition-all", i === index ? "w-6 bg-accent-600" : "w-1.5 bg-zinc-500/30")} />
          ))}
        </span>
      </div>
      <section className="surface border p-6 sm:p-8">
        <h1 className="text-[24px] font-semibold tracking-tight text-balance">{step.title}</h1>
        <div className="mt-4">{children}</div>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {index > 0 && (
            <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-2 text-sm text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          <span className="ml-auto inline-flex items-center gap-3">
            {index < steps.length - 1 && (
              <button type="button" onClick={onSkip} className="inline-flex items-center gap-1.5 text-xs text-muted hover:underline">
                Skip setup <Kbd name="Escape" />
              </button>
            )}
            <Primary label={step.next} onClick={onNext} />
          </span>
        </div>
      </section>
    </main>
  );
};

export const IntroStep = () => (
  <div className="space-y-3 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
    <p>
      pr-report turns a branch into a review page: a plain-English summary, the files in the order to read them, risks with a suggested fix, and
      diffs with notes. You comment on the page, your agent fixes, and the next round comes back to the same tab.
    </p>
    <p>This takes a minute: the tools on this machine, then how the page looks.</p>
  </div>
);

export const ThemeStep = () => {
  const { theme, setTheme } = usePrefs();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Applied as you click. Change it any time from the gear in a report.</p>
      <Choice<ThemeChoice>
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "System", icon: <Monitor className="size-3.5" />, hint: "Follow your OS" },
          { value: "light", label: "Light", icon: <Sun className="size-3.5" />, hint: "Always light" },
          { value: "dark", label: "Dark", icon: <Moon className="size-3.5" />, hint: "Always dark" },
        ]}
      />
    </div>
  );
};

// Arrow keys move the theme choice left and right.
export const useThemeKeys = (active: boolean) => {
  const { theme, setTheme } = usePrefs();
  return useCallback(
    (e: KeyboardEvent) => {
      if (!active || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return false;
      const i = THEME_CHOICES.indexOf(theme);
      setTheme(THEME_CHOICES[(i + (e.key === "ArrowRight" ? 1 : THEME_CHOICES.length - 1)) % THEME_CHOICES.length]);
      return true;
    },
    [active, theme, setTheme],
  );
};

export const CodeThemeStep = () => {
  const { theme, resolvedTheme, codeTheme, renderTheme, setCodeTheme } = usePrefs();
  const themes = codeThemesFor(resolvedTheme);
  const selected = codeTheme[resolvedTheme];
  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({ theme: renderTheme, themeType: resolvedTheme, preferredHighlighter: HIGHLIGHTER, disableFileHeader: true }),
    [renderTheme, resolvedTheme],
  );
  useEffect(() => {
    document.getElementById(`code-theme-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const other = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {theme === "system" ? `Your OS is in ${resolvedTheme} mode, so these are ${resolvedTheme} themes. ` : `Themes drawn for ${resolvedTheme} mode. `}
        {codeThemesFor(other).find((t) => t.id === codeTheme[other])?.name} stays the {other} mode theme; both can change later in the gear of a report.
      </p>
      <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        <ul role="listbox" aria-label="Code theme" className="max-h-[380px] overflow-y-auto rounded-control border border-[var(--border)] p-1">
          {themes.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t.id === selected}
                id={`code-theme-${t.id}`}
                onClick={() => setCodeTheme(resolvedTheme, t.id)}
                className={cx(
                  "flex w-full items-center justify-between rounded-control px-3 py-1.5 text-left text-sm",
                  t.id === selected ? "bg-accent-600/10 font-medium text-accent-700 dark:text-accent-300" : "hover:bg-zinc-500/[0.06]",
                )}
              >
                {t.name}
                {t.id === selected && <Check className="size-3.5" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 overflow-hidden rounded-control border border-[var(--border)] text-[12.5px]">
          <CodeFile file={{ name: "books.ts", contents: SAMPLE }} options={options} />
        </div>
      </div>
    </div>
  );
};

// Arrow keys move the code theme up and down the list.
export const useCodeThemeKeys = (active: boolean) => {
  const { resolvedTheme, codeTheme, setCodeTheme } = usePrefs();
  return useCallback(
    (e: KeyboardEvent) => {
      if (!active || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return false;
      const themes = codeThemesFor(resolvedTheme);
      const i = themes.findIndex((t) => t.id === codeTheme[resolvedTheme]);
      const next = themes[Math.max(0, Math.min(themes.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) setCodeTheme(resolvedTheme, next.id as BundledTheme);
      return true;
    },
    [active, resolvedTheme, codeTheme, setCodeTheme],
  );
};

export const finishSetup = () => {
  markSetupDone();
  window.location.assign(afterSetup());
};
