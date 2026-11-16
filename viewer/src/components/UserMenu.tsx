import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from "@headlessui/react";
import { Bug, CircleArrowUp, CircleHelp, CloudUpload, ExternalLink, LogIn, Settings, Trash2, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bundle, Identity, RepoAvatar } from "../../../skill/schema/types";
import { useIdentity } from "../lib/identity";
import { type DaemonInfo, type Link, type LiveState, useLive } from "../lib/live";
import { PROJECT } from "../lib/meta";
import { pageToken } from "../lib/panel";
import { type ReflektorStatus, useReflektor } from "../lib/reflektor";
import { useReport } from "../lib/state";
import { useUpdate } from "../lib/update";
import { type ReflektorAction, ReflektorDialog } from "./Reflektor";
import { cx } from "./ui";
import { UpdateDialog } from "./UpdateDialog";

const SOURCES: Record<Identity["source"], string> = {
  gh: "via the GitHub CLI",
  glab: "via the GitLab CLI",
  git: "from git config",
  none: "no identity found",
};
const FORGE_NAMES: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" };
const LINKS: Record<Link, { dot: string; label: string }> = {
  up: { dot: "bg-ok-500", label: "Daemon up" },
  restarting: { dot: "bg-warn-500 animate-pulse", label: "Daemon restarting" },
  down: { dot: "bg-danger-500", label: "Daemon unavailable" },
};

// Round, unlike the owner's square avatar on the left, so the two are not mistaken for each other.
const Avatar = ({ avatar, className }: { avatar: RepoAvatar | null; className: string }) => {
  if (!avatar) return <span aria-hidden className={cx("shrink-0 rounded-full bg-zinc-500/20", className)} />;
  if (avatar.image) return <img src={avatar.image} alt="" aria-hidden className={cx("shrink-0 rounded-full object-cover", className)} />;
  return (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-full font-semibold leading-none text-white", className)} style={{ backgroundColor: avatar.color }}>
      {avatar.initials}
    </span>
  );
};

// How long the daemon has run, in its two largest units: "up 23min", "up 1h 23min", "up 2d 5h". A unit that is zero
// is left out ("up 2h"). Nothing is rounded up, so the figure never runs ahead of the clock.
const uptime = (since: string) => {
  const s = (Date.now() - Date.parse(since)) / 1000;
  if (s < 90) return "just started";
  const minutes = Math.floor(s / 60);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const min = minutes % 60;
  const parts = d ? [`${d}d`, h > 0 && `${h}h`] : h ? [`${h}h`, min > 0 && `${min}min`] : [`${min}min`];
  return `up ${parts.filter(Boolean).join(" ")}`;
};

// A new-issue link with what a bug report always needs, and nothing from the report itself.
const bugReportUrl = (daemon: DaemonInfo | null, bundle: Bundle) => {
  const body = [
    "<!-- What happened, and what you expected -->",
    "",
    "",
    "---",
    `Reflektor daemon ${daemon ? `${daemon.version}, Node ${daemon.node}` : "not reachable"}`,
    `Report built ${bundle.builtAt}, round ${bundle.round}`,
    `Browser: ${navigator.userAgent}`,
  ];
  return `${PROJECT.issues}?${new URLSearchParams({ body: body.join("\n") })}`;
};

const item = "group flex w-full items-center gap-3 rounded-control px-2.5 py-2 text-left data-[focus]:bg-zinc-500/10 [&>svg:first-child]:size-4 [&>svg:first-child]:shrink-0 [&>svg:first-child]:text-muted";

export const PurgeDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !ref.current?.open) {
      setResult(null);
      ref.current?.showModal();
    }
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  const purge = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/cache/purge", { method: "POST", headers: { "x-review-token": pageToken() } });
      const data = res.ok ? ((await res.json()) as { removed: number }) : null;
      setResult(data ? `Removed ${data.removed} cached ${data.removed === 1 ? "file" : "files"}.` : "The daemon did not answer.");
    } catch {
      setResult("The daemon did not answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} className="surface m-auto w-[min(440px,94vw)] rounded-control border p-0 text-[var(--text)] shadow-float">
      <div className="space-y-3 px-5 py-4">
        <h2 className="font-semibold">Purge the daemon&rsquo;s cache?</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Avatars and account details under <code className="font-mono text-xs">~/.pr-report/cache</code> are deleted and fetched again when needed. Reviews and saved checks are not touched.
        </p>
        {result && <p className="text-sm">{result}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-zinc-500/10">
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button type="button" onClick={purge} disabled={busy} className="rounded-control bg-danger-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-danger-700 disabled:opacity-60">
              {busy ? "Purging…" : "Purge"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
};

// The line under "Publish to Reflektor": a publish running, the last one that did not work, where the report went, or
// whose account it goes up as.
const publishLine = (status: ReflektorStatus, state: LiveState["reflektor"]) => {
  const { published, error, publishing } = state ?? { published: null, error: null, publishing: false };
  if (publishing) return "Publishing…";
  if (error && (!published || error.at > published.at)) return `Round ${error.round} did not go up`;
  if (published) return `Round ${published.round} is in ${published.organization}`;
  return `As ${status.user?.name ?? status.user?.email ?? "you"}`;
};

// The reader's avatar in the top bar. Its menu holds the page's own things (settings, help, a bug
// report), Reflektor (sign in, publish this review), and the daemon's (its cache and its status), apart from the
// owner menu on the left.
export const UserMenu = ({ onSettings, onHelp }: { onSettings: () => void; onHelp: () => void }) => {
  const { bundle } = useReport();
  const { repo } = bundle.diff;
  const who = useIdentity({ host: repo.host, forge: repo.web?.forge ?? null, root: repo.root });
  const { daemon, link, live, config } = useLive();
  const [purging, setPurging] = useState(false);
  // Reflektor needs the daemon: a report saved as a file has no such block.
  const reflektor = useReflektor(Boolean(config));
  const [reflektorAction, setReflektorAction] = useState<ReflektorAction | null>(null);
  const status = reflektor.status;
  const published = live?.reflektor?.published ?? null;
  const forge = repo.web?.forge ? FORGE_NAMES[repo.web.forge] : null;
  const linkStatus = LINKS[link];

  // A new pr-report: a dot on the avatar and an item at the top of the menu until it is installed, and the modal by
  // itself once per version when the daemon says to ask. An auto-opened modal closes again when another tab answered it.
  const update = useUpdate();
  const [updating, setUpdating] = useState<"auto" | "menu" | null>(null);
  const promptedFor = useRef<string | null>(null);
  const pending = update && update.status !== "none" ? update : null;
  useEffect(() => {
    if (!update) return;
    const version = update.latest ?? update.minimum;
    if (update.prompt && version !== promptedFor.current) {
      promptedFor.current = version;
      setUpdating((u) => u ?? "auto");
    }
    if (!update.prompt && update.state === "idle") setUpdating((u) => (u === "auto" ? null : u));
  }, [update]);

  return (
    <>
      <Menu>
        <MenuButton
          title="Your account and the daemon"
          aria-label="Your account and the daemon"
          className="ml-1 flex items-center rounded-full focus:outline-none data-[focus]:ring-2 data-[focus]:ring-zinc-400/60 data-[open]:ring-2 data-[open]:ring-zinc-400/40"
        >
          <span className="relative">
            <Avatar avatar={who?.avatar ?? null} className="size-7 text-[11px]" />
            {pending && (
              <span aria-hidden className={cx("absolute -top-px -right-px size-2.5 rounded-full ring-2 ring-[var(--bg)]", pending.status === "required" ? "bg-warn-500" : "bg-blue-500")} />
            )}
          </span>
        </MenuButton>
        <MenuItems
          anchor="bottom end"
          transition
          className="surface z-50 w-72 origin-top-right rounded-control border p-1.5 text-sm shadow-float transition duration-100 ease-out [--anchor-gap:6px] focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0"
        >
          <div className="flex items-center gap-3 px-2.5 py-2">
            <Avatar avatar={who?.avatar ?? null} className="size-9 text-sm" />
            <div className="min-w-0">
              <div className="truncate font-medium">{who ? (who.name ?? who.login ?? who.email ?? "Unknown") : "Looking you up…"}</div>
              {who && (
                <div className="truncate text-xs text-muted">
                  {who.login ? `@${who.login}` : (who.email ?? "")}
                  {who.login || who.email ? " · " : ""}
                  {SOURCES[who.source]}
                </div>
              )}
            </div>
          </div>
          <MenuSeparator className="my-1 h-px bg-[var(--border)]" />

          {pending && (
            <>
              <MenuItem>
                <button type="button" onClick={() => setUpdating("menu")} className={item}>
                  <CircleArrowUp />
                  <span className="min-w-0 flex-1">
                    <span className="block">{pending.status === "required" ? "Update needed" : "Update available"}</span>
                    <span className="block truncate text-xs text-muted">pr-report {pending.status === "required" ? `${pending.minimum} or newer` : pending.latest}</span>
                  </span>
                </button>
              </MenuItem>
              <MenuSeparator className="my-1 h-px bg-[var(--border)]" />
            </>
          )}

          {who?.url && (
            <MenuItem>
              <a href={who.url} target="_blank" rel="noreferrer" className={item}>
                <UserRound />
                <span className="flex-1">Open {forge ?? ""} profile</span>
                <ExternalLink className="size-3.5 text-faint opacity-0 group-data-[focus]:opacity-100" />
              </a>
            </MenuItem>
          )}
          <MenuItem>
            <button type="button" onClick={onSettings} className={item}>
              <Settings />
              <span className="flex-1">Settings</span>
              <kbd className="rounded-control border border-[var(--border)] bg-zinc-500/10 px-1.5 font-mono text-xs text-muted">?</kbd>
            </button>
          </MenuItem>
          <MenuItem>
            <button type="button" onClick={onHelp} className={item}>
              <CircleHelp />
              <span className="flex-1">Help</span>
            </button>
          </MenuItem>
          <MenuItem>
            <a href={bugReportUrl(daemon, bundle)} target="_blank" rel="noreferrer" className={item}>
              <Bug />
              <span className="flex-1">Report a bug</span>
              <ExternalLink className="size-3.5 text-faint opacity-0 group-data-[focus]:opacity-100" />
            </a>
          </MenuItem>
          <MenuSeparator className="my-1 h-px bg-[var(--border)]" />

          {config && status && (
            <>
              {status.signedIn ? (
                <MenuItem>
                  <button type="button" onClick={() => setReflektorAction("publish")} className={item}>
                    <CloudUpload />
                    <span className="min-w-0 flex-1">
                      <span className="block">Publish to Reflektor</span>
                      <span className="block truncate text-xs text-muted">{publishLine(status, live?.reflektor)}</span>
                    </span>
                  </button>
                </MenuItem>
              ) : (
                <MenuItem>
                  <button type="button" onClick={() => setReflektorAction("sign-in")} className={item}>
                    <LogIn />
                    <span className="min-w-0 flex-1">
                      <span className="block">Sign in to Reflektor</span>
                      <span className="block truncate text-xs text-muted">Publish reports to your team</span>
                    </span>
                  </button>
                </MenuItem>
              )}
              {status.signedIn && published && (
                <MenuItem>
                  <a href={published.url} target="_blank" rel="noreferrer" className={item}>
                    <ExternalLink />
                    <span className="flex-1">Open on Reflektor</span>
                  </a>
                </MenuItem>
              )}
              <MenuSeparator className="my-1 h-px bg-[var(--border)]" />
            </>
          )}

          <MenuItem>
            <button type="button" onClick={() => setPurging(true)} className={item}>
              <Trash2 />
              <span className="flex-1">Purge daemon cache</span>
            </button>
          </MenuItem>
          <MenuSeparator className="my-1 h-px bg-[var(--border)]" />

          <div role="status" className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted">
            <span aria-hidden className={cx("size-2 shrink-0 rounded-full", linkStatus.dot)} />
            <span className="truncate">
              {linkStatus.label}
              {link === "up" && daemon && ` · ${daemon.version.slice(0, 7)} · ${uptime(daemon.startedAt)}`}
            </span>
          </div>
        </MenuItems>
      </Menu>
      <PurgeDialog open={purging} onClose={() => setPurging(false)} />
      <UpdateDialog open={updating !== null} info={update} onClose={() => setUpdating(null)} />
      {config && (
        <ReflektorDialog
          action={reflektorAction}
          api={config.api}
          onAction={setReflektorAction}
          onClose={() => {
            setReflektorAction(null);
            void reflektor.refresh();
          }}
        />
      )}
    </>
  );
};
