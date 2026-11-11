import { Switch } from "@headlessui/react";
import { Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { BundledTheme } from "shiki/themes";
import { type DiffStyle, type ThemeChoice, usePrefs } from "../lib/prefs";
import { type AgentSettings, useAgentSettings } from "../lib/settings";
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
          "flex flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left",
          value === o.value ? "border-accent bg-accent/[0.06] ring-1 ring-accent" : "border-[var(--border)] hover:bg-zinc-500/[0.06]",
        )}
      >
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          {o.icon}
          {o.label}
        </span>
        <span className="text-xs text-muted">{o.hint}</span>
      </button>
    ))}
  </div>
);

// The one setting the agent reads: whether to split the writing of a report between subagents. The whole row is
// the switch. It is shown in Settings and in the setup wizard.
export const SubagentSwitch = ({ settings, change }: { settings: AgentSettings; change: (patch: Partial<AgentSettings>) => void }) => (
  <Switch
    checked={settings.subagents}
    onChange={(on) => change({ subagents: on })}
    className="group flex w-full items-center justify-between gap-4 rounded-control border border-[var(--border)] px-3 py-2.5 text-left hover:bg-zinc-500/[0.06] data-[checked]:border-accent data-[checked]:bg-accent/[0.06] data-[checked]:ring-1 data-[checked]:ring-accent"
  >
    <span>
      <span className="block text-sm font-medium">Subagentic Mode</span>
      <span className="block text-xs text-muted">Consumes more tokens, but it&rsquo;s hella faster.</span>
    </span>
    <span aria-hidden className="flex h-5 w-9 shrink-0 items-center rounded-control bg-zinc-500/30 p-0.5 transition-colors group-data-[checked]:bg-accent">
      <span className="size-4 rounded-control bg-white transition-transform group-data-[checked]:translate-x-4 group-data-[checked]:bg-on-accent" />
    </span>
  </Switch>
);

// Shown where a daemon keeps the setting. A report saved as a file has none, and leaves the section out.
const WritingSection = () => {
  const { settings, change } = useAgentSettings();
  if (!settings) return null;
  return (
    <section>
      <h3 className="mb-2 label-caps text-xs text-muted">Writing reports</h3>
      <SubagentSwitch settings={settings} change={change} />
    </section>
  );
};

export const SettingsDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { theme, setTheme, resolvedTheme, diffStyle, setDiffStyle, codeTheme, setCodeTheme } = usePrefs();
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
      className="surface m-auto w-[min(480px,94vw)] rounded-control border p-0 text-[var(--text)] shadow-float"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <h2 className="font-semibold">Settings</h2>
        <button type="button" onClick={onClose} className="rounded-control p-1 text-muted hover:bg-zinc-500/10" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-6 px-5 py-4">
        <section>
          <h3 className="mb-2 label-caps text-xs text-muted">Diff view</h3>
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
          <h3 className="mb-2 label-caps text-xs text-muted">Theme</h3>
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
          <h3 className="mb-2 label-caps text-xs text-muted">Code theme</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["dark", "light"] as const).map((mode: ThemeMode) => (
              <label key={mode} className="flex flex-col gap-1 text-xs text-muted">
                <span className="inline-flex items-center gap-1.5">
                  {mode === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  {mode === "dark" ? "Dark mode" : "Light mode"}
                  {resolvedTheme === mode && <span className="text-faint">(on screen now)</span>}
                </span>
                <select
                  value={codeTheme[mode]}
                  onChange={(e) => setCodeTheme(mode, e.target.value as BundledTheme)}
                  className="rounded-control border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] outline-none focus:border-accent"
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

        <WritingSection />

        <section>
          <h3 className="mb-2 label-caps text-xs text-muted">Keyboard shortcuts</h3>
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
          <a href="/setup" className="inline-block text-xs text-muted hover:underline">
            Run the first-time setup again
          </a>
        )}
      </div>
    </dialog>
  );
};
