import { Check, CircleArrowUp, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchUpdate, nextVersion, snoozeUpdate, startUpdate, type UpdateInfo, useUpdate } from "../lib/update";
import { cx } from "./ui";

const STEPS = [
  { state: "checking", label: "Checking the release" },
  { state: "downloading", label: "Downloading" },
  { state: "installing", label: "Installing" },
  { state: "restarting", label: "Restarting" },
] as const;
const BUSY = new Set<UpdateInfo["state"]>(["checking", "downloading", "installing", "restarting"]);

const primary = "inline-flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent/85 disabled:opacity-60";
const secondary = "rounded-control border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-zinc-500/10";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The update modal. "Update now" restarts reflektor on the new version straight away: agents waiting on a review stop
// (they say so, and /reflektor resume carries on), and every open page reloads. The modal says that before the reader
// confirms. While it runs, the modal follows the daemon's steps; the page reloads by itself once the new daemon answers
// (live.tsx), and this modal also reloads when it sees the new version, for pages without the event stream.
// "Later" snoozes this version for a day. A required update has no Later: publishing waits for it.
export const UpdateDialog = ({ open, info, onClose }: { open: boolean; info: UpdateInfo | null; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const [polled, setPolled] = useState<UpdateInfo | null>(null);
  const [started, setStarted] = useState(false);
  const shown = (started ? polled : null) ?? info ?? polled;

  useEffect(() => {
    if (open && !ref.current?.open) {
      setStarted(false);
      setPolled(null);
      ref.current?.showModal();
      if (!info) void fetchUpdate().then(setPolled);
    }
    if (!open && ref.current?.open) ref.current.close();
  }, [open, info]);

  // While updating: follow the daemon until it is replaced, then reload into the new version.
  useEffect(() => {
    if (!started) return;
    const from = polled?.current ?? info?.current;
    const id = window.setInterval(async () => {
      const now = await fetchUpdate();
      if (now && from && now.current !== from) return window.top!.location.reload();
      if (now) setPolled(now);
      else setPolled((p) => (p ? { ...p, state: "restarting" } : p));
    }, 1000);
    return () => window.clearInterval(id);
  }, [started, info, polled?.current]);

  if (!shown) {
    return <dialog ref={ref} onClose={onClose} className="surface m-auto w-[min(480px,94vw)] rounded-control border p-0 text-[var(--text)] shadow-float" />;
  }

  const required = shown.status === "required";
  const busy = started && BUSY.has(shown.state);
  const failed = started && shown.state === "failed";
  const step = STEPS.findIndex((s) => s.state === shown.state);
  const version = nextVersion(shown);

  const later = async () => {
    if (!required) await snoozeUpdate();
    onClose();
  };
  const update = async () => {
    setStarted(true);
    const answer = await startUpdate();
    setPolled(answer ?? { ...shown, state: "failed", error: "The daemon did not answer." });
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => busy && e.preventDefault()}
      onClick={(e) => e.target === ref.current && !busy && void later()}
      aria-labelledby="update-title"
      className="surface m-auto w-[min(480px,94vw)] rounded-control border p-0 text-[var(--text)] shadow-float"
    >
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-1">
          <h2 id="update-title" className="font-semibold">
            {required ? `Update reflektor to keep publishing` : `reflektor ${version} is available`}
          </h2>
          <p className="text-sm text-muted">
            {required ? `Publishing needs reflektor ${shown.minimum} or newer. ` : ""}You have {shown.current}.
          </p>
        </div>

        {shown.notes.length > 0 && (
          <ul className="space-y-1 text-sm">
            {shown.notes.map((note) => (
              <li key={note} className="flex gap-2">
                <span aria-hidden className="font-mono text-faint">
                  ▸
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
        {shown.notesUrl && (
          <a href={shown.notesUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted underline-offset-2 hover:underline">
            All release notes <ExternalLink className="size-3.5" />
          </a>
        )}

        {!started && (
          <p className="rounded-control border border-[var(--border)] bg-zinc-500/5 px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400">
            Updating restarts reflektor now.{" "}
            {shown.waiting > 0
              ? `${plural(shown.waiting, "review has an agent", "reviews have agents")} waiting; ${shown.waiting === 1 ? "it stops" : "they stop"}, and comments and drafts are kept. Run /reflektor resume afterwards. `
              : ""}
            Open pages reload. An agent session that already loaded reflektor keeps the old instructions until its next /reflektor.
          </p>
        )}

        {busy && (
          <ol aria-live="polite" className="space-y-1.5 text-sm">
            {STEPS.map((s, i) => (
              <li key={s.state} className={cx("flex items-center gap-2", i > step && "text-faint")}>
                {i < step ? <Check className="size-4 text-ok-600 dark:text-ok-400" /> : i === step ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <span aria-hidden className="size-4" />}
                <span>
                  {s.label}
                  {s.state === "downloading" && i === step ? ` ${version}` : ""}
                  {i === step ? "…" : ""}
                </span>
              </li>
            ))}
          </ol>
        )}

        {failed && (
          <p role="alert" className="rounded-control border border-danger-500/40 bg-danger-500/5 px-3 py-2 text-sm">
            The update did not happen, and reflektor {shown.current} is still installed. {shown.error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {!busy && (
            <button type="button" onClick={() => void later()} className={secondary}>
              {failed || required ? "Close" : "Later"}
            </button>
          )}
          {!busy && (
            <button type="button" onClick={() => void update()} className={primary} autoFocus>
              {failed ? "Try again" : "Update now"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
};

// Above a report while Reflektor refuses this version: publishing waits for the update, so the page says so where it
// is seen, not only in the menu.
export const UpdateBanner = () => {
  const update = useUpdate();
  const [open, setOpen] = useState(false);
  if (update?.status !== "required") return null;
  return (
    <div className="border-b border-warn-500/30 bg-warn-50 dark:bg-warn-950/60">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm sm:px-6">
        <CircleArrowUp className="size-4 shrink-0 text-warn-600 dark:text-warn-400" />
        <span>
          Publishing needs reflektor {update.minimum} or newer. This is {update.current}.
        </span>
        <button type="button" onClick={() => setOpen(true)} className="ml-auto rounded-control border border-warn-500/40 px-2.5 py-1 text-xs font-medium hover:bg-warn-500/10">
          Update now
        </button>
      </div>
      <UpdateDialog open={open} info={update} onClose={() => setOpen(false)} />
    </div>
  );
};
