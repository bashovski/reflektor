import { Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { BundledTheme } from "shiki/themes";
import { type DiffStyle, type ThemeChoice, useReport } from "../lib/state";
import { codeThemesFor, type ThemeMode } from "../lib/themes";
import { cx, Kbd, MOD_KEY } from "./ui";

export const SHORTCUTS = [
  ["j", "Next file"],
  ["k", "Previous file"],
  ["v", "Mark the current file as viewed"],
  ["o", "Open or close the current file"],
  ["f", "Show the current file in full"],
  ["c", "Comment on the current file"],
  ["?", "Open these settings"],
  [`${MOD_KEY}+Enter`, "Send the review"],
] as const;

// A row of equal buttons, one of them chosen. Shared with the setup page.
export const Choice = <T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode; hint: string }[];
}) => (
  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        onClick={() => onChange(o.value)}
        className={cx(
          "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left",
          value === o.value ? "border-blue-500 bg-blue-500/[0.06] ring-1 ring-blue-500" : "border-[var(--border)] hover:bg-zinc-500/[0.06]",
        )}
      >
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          {o.icon}
          {o.label}
        </span>
        <span className="text-xs text-zinc-500">{o.hint}</span>
      </button>
    ))}
  </div>
);

export const SettingsDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { theme, setTheme, resolvedTheme, diffStyle, setDiffStyle, codeTheme, setCodeTheme } = useReport();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="surface m-auto w-[min(480px,94vw)] rounded-xl border p-0 text-[var(--text)] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <h2 className="font-semibold">Settings</h2>
        <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-500/10" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-6 px-5 py-4">
        <section>
          <h3 className="mb-2 label-caps text-xs text-zinc-500">Diff view</h3>
          <Choice<DiffStyle>
            value={diffStyle}
            onChange={setDiffStyle}
            options={[
              { value: "unified", label: "Unified", hint: "One column" },
              { value: "split", label: "Split", hint: "Old and new side by side" },
            ]}
          />
        </section>

        <section>
          <h3 className="mb-2 label-caps text-xs text-zinc-500">Theme</h3>
          <Choice<ThemeChoice>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System", icon: <Monitor className="size-3.5" />, hint: "Follow your OS" },
              { value: "light", label: "Light", icon: <Sun className="size-3.5" />, hint: "Always light" },
              { value: "dark", label: "Dark", icon: <Moon className="size-3.5" />, hint: "Always dark" },
            ]}
          />
        </section>

        <section>
          <h3 className="mb-2 label-caps text-xs text-zinc-500">Code theme</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["dark", "light"] as const).map((mode: ThemeMode) => (
              <label key={mode} className="flex flex-col gap-1 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1.5">
                  {mode === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  {mode === "dark" ? "Dark mode" : "Light mode"}
                  {resolvedTheme === mode && <span className="text-zinc-400">(on screen now)</span>}
                </span>
                <select
                  value={codeTheme[mode]}
                  onChange={(e) => setCodeTheme(mode, e.target.value as BundledTheme)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] outline-none focus:border-blue-500"
                >
                  {codeThemesFor(mode).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 label-caps text-xs text-zinc-500">Keyboard shortcuts</h3>
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {SHORTCUTS.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2.5">
                <span className="inline-flex items-center gap-0.5">
                  {key.split("+").map((k) => (
                    <Kbd key={k} name={k} />
                  ))}
                </span>
                <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
              </li>
            ))}
          </ul>
        </section>

        {window.__PR_REVIEW__ && (
          <a href="/setup" className="inline-block text-xs text-zinc-500 hover:underline">
            Run the first-time setup again
          </a>
        )}
      </div>
    </dialog>
  );
};
