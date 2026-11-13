import { Switch } from "@headlessui/react";
import { Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { BundledTheme } from "shiki/themes";
import { type DiffStyle, type ThemeChoice, usePrefs } from "../lib/prefs";
import { type ReflektorStatus, useReflektor } from "../lib/reflektor";
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

// A card the reader can choose: an outline, and the accent when it is the chosen one. The buttons of a `Choice` and
// the switch below look the same through it.
const card = (chosen: boolean) => cx("rounded-control border text-left", chosen ? "border-accent bg-accent/[0.06] ring-1 ring-accent" : "border-[var(--border)] hover:bg-zinc-500/[0.06]");

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
        className={cx("flex flex-col items-start gap-0.5 px-3 py-2", card(value === o.value))}
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

// A setting that is on or off. The whole row is the switch.
const SettingSwitch = ({ on, onChange, title, hint }: { on: boolean; onChange: (next: boolean) => void; title: string; hint: ReactNode }) => (
  <Switch checked={on} onChange={onChange} className={cx("flex w-full items-center justify-between gap-4 px-3 py-2.5", card(on))}>
    <span>
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted">{hint}</span>
    </span>
    <span aria-hidden className={cx("flex h-5 w-9 shrink-0 items-center rounded-control p-0.5 transition-colors", on ? "bg-accent" : "bg-zinc-500/30")}>
      <span className={cx("size-4 rounded-control transition-transform", on ? "translate-x-4 bg-on-accent" : "bg-white")} />
    </span>
  </Switch>
);

// The setting the agent reads: whether to split the writing of a report between subagents. It is shown in Settings
// and in the setup wizard.
export const SubagentSwitch = ({ settings, change }: { settings: AgentSettings; change: (patch: Partial<AgentSettings>) => void }) => (
  <SettingSwitch on={settings.subagents} onChange={(next) => change({ subagents: next })} title="Subagentic Mode" hint={<>Consumes more tokens, but it&rsquo;s hella faster.</>} />
);

// Shown where a daemon keeps the setting. A report saved as a file has none, and leaves the section out.
const WritingSection = ({ open }: { open: boolean }) => {
  const { settings, change } = useAgentSettings(open);
  if (!settings) return null;
  return (
    <section>
      <h3 className="mb-2 label-caps text-xs text-muted">Writing reports</h3>
      <SubagentSwitch settings={settings} change={change} />
    </section>
  );
};

const smallButton = "shrink-0 rounded-control border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-zinc-500/10 disabled:opacity-50 disabled:hover:bg-transparent";

// Where Reflektor's API is, for a self-hosted Reflektor. A login keeps the API it was made with, so the address can
// only change while signed out; signed in, it is shown as it is in use.
const ApiUrlField = ({ status, settings, save, refresh }: { status: ReflektorStatus; settings: AgentSettings; save: (patch: Partial<AgentSettings>) => Promise<AgentSettings>; refresh: () => Promise<unknown> }) => {
  const saved = settings.reflektorApiUrl || status.defaultApiUrl;
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => setDraft(saved), [saved]);

  const store = async (value: string, done: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await save({ reflektorApiUrl: value });
      setDraft(next.reflektorApiUrl || status.defaultApiUrl);
      setNote(done);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isDefault = settings.reflektorApiUrl === "";
  const changed = draft.trim() !== saved;

  if (status.signedIn)
    return (
      <div className="mt-3 text-xs text-muted">
        <span className="block">
          API: <span className="font-mono text-[var(--text)]">{status.apiUrl}</span>
        </span>
        <span className="block">Sign out to use another address.</span>
      </div>
    );

  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !busy) void store(draft, "Saved. Signing in uses this address.");
      }}
    >
      <label htmlFor="reflektor-api-url" className="mb-1 block text-xs text-muted">
        API URL
      </label>
      <div className="flex items-center gap-2">
        <input
          id="reflektor-api-url"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            setNote(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="reflektor-api-url-hint"
          className="min-w-0 flex-1 rounded-control border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--text)] outline-none focus:border-accent"
        />
        <button type="submit" disabled={!changed || busy} className={smallButton}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={isDefault || busy} onClick={() => void store("", "Back to Reflektor's own address.")} className={smallButton}>
          Reset to default
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-600 dark:text-danger-400">
          {error}
        </p>
      )}
      {note && !error && (
        <p role="status" className="mt-1.5 text-xs text-muted">
          {note}
        </p>
      )}
      <p id="reflektor-api-url-hint" className="mt-1.5 text-xs text-muted">
        Change it for a self-hosted Reflektor. The default is <span className="font-mono">{status.defaultApiUrl}</span>.
        {status.apiUrlFromEnv && " REFLEKTOR_API_URL is set where the daemon runs, so that address is used instead."}
      </p>
    </form>
  );
};

// The Reflektor account the daemon publishes as, whether it publishes by itself, and the API it talks to. The account
// and the switch show once signed in; signing in is in the reader's menu on a report.
const ReflektorSection = ({ open }: { open: boolean }) => {
  const { status, signOut, refresh } = useReflektor(open);
  const { settings, change, save } = useAgentSettings(open);
  if (!status || !settings) return null;
  return (
    <section>
      <h3 className="mb-2 label-caps text-xs text-muted">Reflektor</h3>
      {status.signedIn && (
        <>
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              Signed in as {status.user?.name ?? status.user?.email}
              {status.user?.name && <span className="text-muted"> · {status.user.email}</span>}
            </span>
            <button type="button" onClick={() => void signOut().catch(() => {})} className={smallButton}>
              Sign out
            </button>
          </div>
          <SettingSwitch
            on={settings.reflektorAutoPublish}
            onChange={(next) => change({ reflektorAutoPublish: next })}
            title="Publish while the pull request is open"
            hint="Each finished round goes to your organization on its own, once its repository is approved there."
          />
        </>
      )}
      <ApiUrlField status={status} settings={settings} save={save} refresh={refresh} />
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

        <WritingSection open={open} />

        <ReflektorSection open={open} />

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
