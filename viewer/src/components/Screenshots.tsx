import { Camera, ChevronLeft, ChevronRight, ImageOff, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenshotsRun, Shot, ShotSet, ShotShape } from "../../../skill/schema/types";
import { shotSrc, useScreenshots } from "../lib/screenshots";
import { Card, cx, RefLink, SectionTitle } from "./ui";

// Pictures of the changed UI, taken by screenshots.mts from the agent's plan while the report was written. A set is
// the screens of a flow in order, the states of one page, or a single change. A click opens a shot full size, and the
// arrows step through every shot in the report.

const SHAPES: Record<ShotShape, string> = { flow: "Flow", states: "States", single: "Single change" };

type Entry = { set: ShotSet; shot: Shot; index: number; src: string };

const Placeholder = ({ shot, running }: { shot: Shot; running: boolean }) => (
  <span className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 border border-[var(--border)] bg-[var(--surface-2)] px-3 text-center text-xs text-muted">
    {shot.status === "failed" ? (
      <>
        <ImageOff className="size-4 text-danger-500" />
        <span className="line-clamp-3 text-danger-700 dark:text-danger-300">{shot.error ?? "Not taken"}</span>
      </>
    ) : running ? (
      <>
        <Loader2 className="size-4 animate-spin text-agent-500" />
        Taking it
      </>
    ) : (
      <>
        <ImageOff className="size-4 text-faint" />
        {shot.status === "taken" ? "The picture is not in this file" : "Not taken"}
      </>
    )}
  </span>
);

const ShotCard = ({ set, shot, number, src, running, onOpen }: { set: ShotSet; shot: Shot; number: number; src: string | null; running: boolean; onOpen: (e: HTMLElement) => void }) => (
  <li className="min-w-0">
    {src ? (
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        className="group relative block w-full overflow-hidden border border-[var(--border)] bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-label={`Open screenshot: ${shot.caption}`}
      >
        <img src={src} alt={shot.caption} loading="lazy" className="aspect-[16/10] w-full object-cover object-top transition-opacity group-hover:opacity-90" />
      </button>
    ) : (
      <Placeholder shot={shot} running={running} />
    )}
    <p className="mt-2 flex items-start gap-2 text-sm leading-snug">
      {set.shape === "flow" && (
        <span className="num mt-px flex size-[18px] shrink-0 items-center justify-center rounded-control bg-zinc-500/15 text-[11px] font-semibold text-muted">{number}</span>
      )}
      <span className="min-w-0">{shot.caption}</span>
    </p>
    {shot.refs.length > 0 && (
      <div className={cx("mt-1 -ml-1.5 flex flex-wrap gap-x-1", set.shape === "flow" && "pl-[26px]")}>
        {shot.refs.map((ref) => (
          <RefLink key={`${ref.path}:${ref.line ?? ""}`} refTo={ref} keep={2} />
        ))}
      </div>
    )}
  </li>
);

const Lightbox = ({ entries, at, onMove, onClose }: { entries: Entry[]; at: number | null; onMove: (i: number) => void; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const entry = at === null ? null : entries[at];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (entry && !dialog.open) dialog.showModal();
    if (!entry && dialog.open) dialog.close();
  }, [entry]);

  const step = useCallback((by: number) => at !== null && entries.length > 1 && onMove((at + by + entries.length) % entries.length), [at, entries.length, onMove]);

  return (
    <dialog
      ref={ref}
      aria-label="Screenshot"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
        else return;
        e.preventDefault();
      }}
      className="surface m-auto max-h-[96vh] w-[min(1400px,96vw)] max-w-none overflow-hidden rounded-control border p-0 text-[var(--text)] shadow-float backdrop:bg-zinc-950/70"
    >
      {entry && (
        <div className="flex max-h-[96vh] flex-col">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
            <span className="num shrink-0 text-xs text-muted">
              {at! + 1} / {entries.length}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.set.title}</span>
            <span className="hidden shrink-0 label-caps text-[11px] text-muted sm:inline">{SHAPES[entry.set.shape]}</span>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-control p-1 text-muted hover:bg-zinc-500/10 hover:text-zinc-900 active:scale-[0.97] dark:hover:text-zinc-100">
              <X className="size-4" />
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[var(--surface-2)]">
            <img src={entry.src} alt={entry.shot.caption} className="max-h-[calc(96vh-140px)] w-auto max-w-full object-contain" />
            {entries.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  aria-label="Previous screenshot"
                  className="absolute top-1/2 left-3 -translate-y-1/2 rounded-control border border-[var(--border)] bg-[var(--surface)] p-2 shadow-float hover:bg-zinc-500/10 active:scale-[0.97]"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => step(1)}
                  aria-label="Next screenshot"
                  className="absolute top-1/2 right-3 -translate-y-1/2 rounded-control border border-[var(--border)] bg-[var(--surface)] p-2 shadow-float hover:bg-zinc-500/10 active:scale-[0.97]"
                >
                  <ChevronRight className="size-4" />
                </button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] px-4 py-2.5">
            {entry.set.shape === "flow" && <span className="num text-xs text-muted">Step {entry.index + 1}</span>}
            <span className="text-sm">{entry.shot.caption}</span>
            {entry.shot.refs.length > 0 && (
              <span className="flex flex-wrap gap-x-1" onClickCapture={onClose}>
                {entry.shot.refs.map((r) => (
                  <RefLink key={`${r.path}:${r.line ?? ""}`} refTo={r} keep={2} />
                ))}
              </span>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
};

const summaryOf = (run: ScreenshotsRun) => {
  const shots = run.sets.flatMap((s) => s.shots);
  const taken = shots.filter((s) => s.status === "taken").length;
  if (run.status === "preparing") return "getting the app ready";
  if (run.status === "running") return `taking them, ${taken} of ${shots.length} done`;
  if (run.skipped) return "none taken";
  if (run.status === "stopped") return `stopped after ${taken} of ${shots.length}`;
  return `${taken} of ${shots.length} taken`;
};

export const Screenshots = () => {
  const run = useScreenshots();
  const [at, setAt] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const entries = useMemo<Entry[]>(() => {
    if (!run) return [];
    return run.sets.flatMap((set) =>
      set.shots.flatMap((shot, index) => {
        const src = shot.status === "taken" ? shotSrc(shot, run) : null;
        return src ? [{ set, shot, index, src }] : [];
      }),
    );
  }, [run]);

  const close = useCallback(() => {
    setAt(null);
    opener.current?.focus();
  }, []);

  if (!run) return null;
  const busy = run.status === "running" || run.status === "preparing";

  return (
    <div id="screenshots">
      <SectionTitle right={<span className="text-xs text-muted">{summaryOf(run)}</span>}>
        <span className="inline-flex items-center gap-2">
          <Camera className="size-4" /> Screenshots
        </span>
      </SectionTitle>

      {run.status === "preparing" && (
        <Card className="flex items-center gap-2 px-4 py-3 text-sm text-muted sm:px-5">
          <Loader2 className="size-4 animate-spin text-agent-500" /> Getting the app ready. Screenshots appear here as they are taken.
        </Card>
      )}
      {run.skipped && <Card className="px-4 py-3 text-sm text-muted sm:px-5">{run.skipped}</Card>}
      {run.status === "stopped" && !run.skipped && (
        <p className="mb-3 text-xs text-warn-600 dark:text-warn-400">The run ended before its last screenshot, so some were not taken.</p>
      )}

      <div className="space-y-3">
        {run.sets.map((set) => (
          <Card key={set.id} id={`shots-${set.id}`} className="px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-semibold">{set.title}</h3>
              <span className="label-caps text-[11px] text-muted">{SHAPES[set.shape]}</span>
              <span className="label-caps text-[11px] text-faint">{set.auth === "signed-in" ? "Signed in" : "Signed out"}</span>
            </div>
            {set.summary && <p className="mt-0.5 text-sm text-muted">{set.summary}</p>}
            <ol className="mt-4 grid gap-x-4 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              {set.shots.map((shot, n) => {
                const index = entries.findIndex((e) => e.shot === shot);
                return (
                  <ShotCard
                    key={shot.id}
                    set={set}
                    shot={shot}
                    number={n + 1}
                    src={index >= 0 ? entries[index].src : null}
                    running={busy && shot.status === "pending"}
                    onOpen={(el) => {
                      opener.current = el;
                      setAt(index);
                    }}
                  />
                );
              })}
            </ol>
          </Card>
        ))}
      </div>
      <Lightbox entries={entries} at={at !== null && at < entries.length ? at : null} onMove={setAt} onClose={close} />
    </div>
  );
};
