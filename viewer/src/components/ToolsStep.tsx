import { Check, ClipboardCopy, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cx } from "./ui";

// The tools on this machine that pr-report can use: the GitHub and GitLab command lines. pr-report
// has no accounts of its own; "connected" means the tool is installed and logged in. The daemon
// checks both (GET /api/setup/tools) and this step asks it every few seconds while it is open, so
// the tick appears as soon as the user has logged in from a terminal.

export type ToolState = { installed: boolean; version: string | null; loggedIn: boolean; account: string | null; host: string | null };
export type ToolsReport = { gh: ToolState; glab: ToolState };

type Os = "win" | "mac" | "linux";
const os: Os = /Windows/.test(navigator.userAgent) ? "win" : /Mac/.test(navigator.userAgent) ? "mac" : "linux";

const GitHubMark = () => (
  <svg viewBox="0 0 16 16" className="size-7" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const GitLabMark = () => (
  <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden>
    <path d="m23.6 9.6-.03-.09-3.27-8.53a.85.85 0 0 0-.34-.4.87.87 0 0 0-1 .05.87.87 0 0 0-.29.44L16.46 7.8H7.56L5.35 1.07a.86.86 0 0 0-.29-.44.87.87 0 0 0-1-.05.86.86 0 0 0-.34.4L.42 9.5l-.03.09a6.07 6.07 0 0 0 2.01 7.01l.01.01.03.02 4.98 3.73 2.46 1.86 1.5 1.13a1.01 1.01 0 0 0 1.22 0l1.5-1.13 2.46-1.86 5.01-3.75.01-.01a6.07 6.07 0 0 0 2.02-7.01z" />
  </svg>
);

type Tool = {
  key: keyof ToolsReport;
  name: string;
  icon: ReactNode;
  gives: string;
  install: Record<Os, string>;
  login: string;
};

const TOOLS: Tool[] = [
  {
    key: "gh",
    name: "GitHub",
    icon: <GitHubMark />,
    gives: "Reports take the base branch from the open pull request and link to it, and Claude can open the pull request for you.",
    install: { win: "winget install --id GitHub.cli", mac: "brew install gh", linux: "See cli.github.com for your distribution" },
    login: "gh auth login",
  },
  {
    key: "glab",
    name: "GitLab",
    icon: <GitLabMark />,
    gives: "Reports take the target branch from the open merge request and link to it, and Claude can open the merge request for you.",
    install: { win: "winget install --id GLab.GLab", mac: "brew install glab", linux: "See gitlab.com/gitlab-org/cli for your distribution" },
    login: "glab auth login",
  },
];

// Asks the daemon about the tools every few seconds while the step is open. Without the daemon (the
// dev server) there is nothing to ask, and the cards say so.
const useTools = () => {
  const [tools, setTools] = useState<ToolsReport | "unavailable" | null>(null);
  useEffect(() => {
    const config = window.__PR_SETUP__;
    if (!config) {
      setTools("unavailable");
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/setup/tools", { headers: { "x-review-token": config.token } });
        if (res.ok && !stopped) setTools((await res.json()) as ToolsReport);
      } catch {
        // The daemon is away for a moment; the next poll tries again.
      }
    };
    void poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);
  return tools;
};

const Command = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const runnable = !text.startsWith("See ");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The command is on screen to type by hand.
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <code className={cx("rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px]", !runnable && "font-sans")}>{text}</code>
      {runnable && (
        <button type="button" onClick={copy} title="Copy" className="inline-flex items-center gap-1 rounded p-1 text-zinc-500 hover:bg-zinc-500/10 hover:text-zinc-900 dark:hover:text-zinc-100">
          <ClipboardCopy className="size-3.5" />
          {copied && <span className="text-[11px]">Copied</span>}
        </button>
      )}
    </span>
  );
};

const statusText = (state: ToolState | "unavailable" | null) => {
  if (state === null) return "Checking…";
  if (state === "unavailable") return "Open this page from the review daemon to check";
  if (!state.installed) return "Not installed";
  if (!state.loggedIn) return `Installed${state.version ? ` (${state.version})` : ""}, not logged in`;
  return `Logged in${state.account ? ` as ${state.account}` : ""}${state.host && state.host !== "github.com" && state.host !== "gitlab.com" ? ` on ${state.host}` : ""}`;
};

export const ToolsStep = () => {
  const tools = useTools();
  const [open, setOpen] = useState<Tool["key"] | null>(null);
  const stateOf = (key: Tool["key"]) => (tools === null || tools === "unavailable" ? tools : tools[key]);
  const connected = (key: Tool["key"]) => {
    const s = stateOf(key);
    return s !== null && s !== "unavailable" && s.loggedIn;
  };
  const shown = open ? TOOLS.find((t) => t.key === open) : undefined;

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        pr-report works without these. With one of them, a report knows the pull request it belongs to, and Claude can open one for you. Click a
        tool to see how to connect it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {TOOLS.map((tool) => {
          const state = stateOf(tool.key);
          const ok = connected(tool.key);
          return (
            <button
              key={tool.key}
              type="button"
              aria-pressed={open === tool.key}
              onClick={() => setOpen(open === tool.key ? null : tool.key)}
              className={cx(
                "relative flex flex-col items-start gap-3 rounded-xl border p-4 text-left",
                open === tool.key ? "border-blue-500 ring-1 ring-blue-500" : "border-[var(--border)] hover:bg-zinc-500/[0.04]",
              )}
            >
              <span className="text-zinc-800 dark:text-zinc-100">{tool.icon}</span>
              <span>
                <span className="block font-semibold">{tool.name}</span>
                <span className="block text-xs text-zinc-500">{statusText(state)}</span>
              </span>
              <span
                className={cx(
                  "absolute right-3 bottom-3 grid size-6 place-items-center rounded-full",
                  ok ? "bg-emerald-500 text-white" : "border border-[var(--border)] text-zinc-400",
                )}
                title={ok ? "Connected" : "Not connected"}
              >
                {state === null ? <Loader2 className="size-3.5 animate-spin" /> : ok ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </span>
            </button>
          );
        })}
      </div>
      {shown && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">{shown.gives}</p>
          {connected(shown.key) ? (
            <p className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <Check className="size-4" /> Connected. Nothing to do here.
            </p>
          ) : (
            <ol className="space-y-2">
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">Install</span>
                <Command text={shown.install[os]} />
              </li>
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">Log in</span>
                <Command text={shown.login} />
              </li>
              <li className="text-xs text-zinc-500">Run these in a terminal. This page checks every few seconds and ticks the box once you are logged in.</li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
};
