import { Camera, ChevronDown, ChevronLeft, ChevronRight, ImageOff, Loader2, MessageSquare, MessageSquarePlus, X } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentTarget, ScreenshotsRun, Shot, ShotSet, ShotShape } from "../../../skill/schema/types";
import { PREF_KEYS, storage } from "../lib/prefs";
import { targetKey, useReview } from "../lib/review";
import { shotSrc, useScreenshots } from "../lib/screenshots";
import { TargetComments } from "./Comments";
import { Card, cx, RefLink, SectionTitle } from "./ui";

// Pictures of the changed UI, taken by screenshots.mts from the agent's plan while the report was written. A set is
// the screens of a flow in order, the states of one page, or a single change. A click opens a shot full size, and the
// arrows step through every shot in the report.
//
// Folded by default to one strip of small pictures, so the section takes little room above the code; the viewer still
// shows each caption and its code links. Unfolded, each set gets a card with its summary, captions and links. The
// reader's choice is kept in this browser.
//
// Comments: the button on a thumbnail opens the viewer with a comment box for the whole screenshot, and a click on the
// picture in the viewer pins a comment to that spot. The viewer lists a picture's comments beside it, numbered like its
// pins. A comment names the picture by its file, which is named by its content, so it keeps pointing at the picture
// the reviewer saw after a later round takes the shot again.

const SHAPES: Record<ShotShape, string> = { flow: "Flow", states: "States", single: "Single change" };

type Entry = { set: ShotSet; shot: Shot; index: number; src: string };
type Pin = { x: number; y: number };
type ShotTarget = Extract<CommentTarget, { type: "screenshot" }>;

// The review bar's comment list asks for a screenshot comment's picture with this event; the section opens it.
export const SHOW_SHOT_EVENT = "reflektor:show-shot";

const shotTarget = (set: ShotSet, shot: Shot, pin?: Pin): ShotTarget => ({
  type: "screenshot",
  set: set.id,
  shot: shot.id,
  caption: shot.caption,
  file: shot.file!,
  ...(pin ? { pin } : {}),
});

// The comments and live questions on one picture, by target: the whole picture first, then its pins in the order
// they were made, numbered from 1.
const useShotThreads = (file: string | null) => {
  const { comments, questions, composer } = useReview();
  return useMemo(() => {
    if (!file) return { whole: null, pins: [] as ShotTarget[], count: 0 };
    const mine = [...comments, ...questions]
      .filter((c) => c.target.type === "screenshot" && c.target.file === file)
      .sort((a, b) => ("createdAt" in a ? a.createdAt : a.askedAt).localeCompare("createdAt" in b ? b.createdAt : b.askedAt));
    const targets = new Map<string, ShotTarget>();
    for (const c of mine) targets.set(targetKey(c.target), c.target as ShotTarget);
    if (composer?.target.type === "screenshot" && composer.target.file === file) targets.set(composer.key, composer.target);
    const list = [...targets.values()];
    return { whole: list.find((t) => !t.pin) ?? null, pins: list.filter((t) => t.pin), count: mine.length };
  }, [file, comments, questions, composer]);
};

// The comment button on a thumbnail: on hover, or always once the picture has comments, with their count.
const CommentButton = ({ file, onComment }: { file: string; onComment: (el: HTMLElement) => void }) => {
  const { editable } = useReview();
  const { count } = useShotThreads(file);
  if (!count && !editable) return null;
  return (
    <button
      type="button"
      title={count ? `${count} ${count === 1 ? "comment" : "comments"}` : "Comment on this screenshot"}
      aria-label={count ? `${count} ${count === 1 ? "comment" : "comments"} on this screenshot` : "Comment on this screenshot"}
      onClick={(e) => onComment(e.currentTarget)}
      className={cx(
        "absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-control border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-[11px] font-medium text-muted shadow-float transition-opacity hover:text-zinc-900 focus-visible:opacity-100 active:scale-[0.97] dark:hover:text-zinc-100",
        !count && "opacity-0 group-hover/shot:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {count ? <MessageSquare className="size-3.5" /> : <MessageSquarePlus className="size-3.5" />}
      {count > 0 && <span className="num">{count}</span>}
    </button>
  );
};

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

const ShotCard = ({
  set,
  shot,
  number,
  src,
  running,
  onOpen,
  onComment,
}: {
  set: ShotSet;
  shot: Shot;
  number: number;
  src: string | null;
  running: boolean;
  onOpen: (e: HTMLElement) => void;
  onComment: (e: HTMLElement) => void;
}) => (
  <li className="min-w-0">
    {src ? (
      <div className="group/shot relative">
        <button
          type="button"
          onClick={(e) => onOpen(e.currentTarget)}
          className="group relative block w-full overflow-hidden border border-[var(--border)] bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={`Open screenshot: ${shot.caption}`}
        >
          <img src={src} alt={shot.caption} loading="lazy" className="aspect-[16/10] w-full object-cover object-top transition-opacity group-hover:opacity-90" />
        </button>
        <CommentButton file={shot.file!} onComment={onComment} />
      </div>
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

// A pin on the picture: a numbered square at the spot, in the accent color while its comment box is open.
const PinMark = ({ pin, label, active, onClick }: { pin: Pin; label: string; active: boolean; onClick?: () => void }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onClick?.();
    }}
    aria-label={`Comment ${label}`}
    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
    className={cx(
      "num absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-control border-2 text-[11px] font-semibold shadow-float",
      active ? "border-on-accent bg-accent text-on-accent" : "border-white bg-zinc-900 text-white",
    )}
  >
    {label}
  </button>
);

// The comments on the picture on screen, beside it: the whole picture's, then each pin's under its number.
const ShotComments = ({ entry, threads, onPinFocus }: { entry: Entry; threads: ReturnType<typeof useShotThreads>; onPinFocus: (key: string) => void }) => {
  const { editable, composer, openComposer } = useReview();
  const whole = shotTarget(entry.set, entry.shot);
  const composingWhole = composer?.key === targetKey(whole);
  return (
    <aside className="flex min-h-0 flex-col border-t border-[var(--border)] lg:w-[340px] lg:shrink-0 lg:border-t-0 lg:border-l [&_[data-comment-actions]]:ml-auto [&_[data-comment-item]]:flex-wrap [&_[data-comment-text]]:order-last [&_[data-comment-text]]:basis-full [&_[data-composer-hint]]:hidden">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3">
        <span className="label-caps text-[11px] text-muted">Comments</span>
        {threads.count > 0 && <span className="num text-[11px] text-muted">{threads.count}</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-2 pb-4">
        {threads.whole && (
          <div>
            <p className="text-xs text-muted">Whole screenshot</p>
            <TargetComments target={threads.whole} placeholder="What should change on this screen?" />
          </div>
        )}
        {threads.pins.map((t, i) => (
          <div key={targetKey(t)} id={`pin-${targetKey(t)}`} onMouseEnter={() => onPinFocus(targetKey(t))}>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <span className="num flex size-[18px] items-center justify-center rounded-control bg-zinc-900 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                {i + 1}
              </span>
              Pinned
            </p>
            <TargetComments target={t} placeholder="What should change here?" />
          </div>
        ))}
        {!threads.count && !composer && <p className="text-[13px] text-faint">{editable ? "No comments yet." : "No comments."}</p>}
        {editable && !composingWhole && !threads.whole && (
          <button
            type="button"
            onClick={() => openComposer(whole)}
            className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-500/10 active:scale-[0.97] dark:text-zinc-400"
          >
            <MessageSquarePlus className="size-3.5" /> Comment on the whole screenshot
          </button>
        )}
        {editable && <p className="text-[11px] text-faint">Click the picture to pin a comment to a spot.</p>}
      </div>
    </aside>
  );
};

const Lightbox = ({ entries, at, onMove, onClose }: { entries: Entry[]; at: number | null; onMove: (i: number) => void; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const entry = at === null ? null : entries[at];
  const { editable, composer, openComposer, closeComposer } = useReview();
  const threads = useShotThreads(entry?.shot.file ?? null);
  const [focused, setFocused] = useState<string | null>(null);
  const shotComposer = composer?.target.type === "screenshot" ? composer : null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (entry && !dialog.open) {
      dialog.showModal();
      // Opening moves the focus to the first button; a comment box opened with the viewer keeps it.
      dialog.querySelector("textarea")?.focus();
    }
    if (!entry && dialog.open) dialog.close();
  }, [entry]);

  const leave = useCallback(() => {
    if (shotComposer) closeComposer();
    onClose();
  }, [shotComposer, closeComposer, onClose]);

  const step = useCallback(
    (by: number) => {
      if (at === null || entries.length < 2) return;
      if (shotComposer) closeComposer();
      onMove((at + by + entries.length) % entries.length);
    },
    [at, entries.length, onMove, shotComposer, closeComposer],
  );

  // A click on the picture pins a comment to that spot, as fractions of the picture's size so it holds at any size.
  const pinAt = (e: MouseEvent<HTMLImageElement>) => {
    if (!entry || !editable) return;
    const box = e.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
    openComposer(shotTarget(entry.set, entry.shot, { x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height) }));
  };

  const showPin = (key: string) => {
    setFocused(key);
    document.getElementById(`pin-${key}`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <dialog
      ref={ref}
      aria-label="Screenshot"
      onClose={leave}
      onCancel={(e) => {
        // Escape closes an open comment box first, and the viewer only after.
        if (!shotComposer) return;
        e.preventDefault();
        closeComposer();
      }}
      onClick={(e) => e.target === ref.current && leave()}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("textarea, input")) return;
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
        else return;
        e.preventDefault();
      }}
      className="surface m-auto max-h-[96vh] w-[min(1600px,96vw)] max-w-none overflow-hidden rounded-control border p-0 text-[var(--text)] shadow-float backdrop:bg-zinc-950/70"
    >
      {entry && (
        <div className="flex max-h-[96vh] flex-col">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
            <span className="num shrink-0 text-xs text-muted">
              {at! + 1} / {entries.length}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.set.title}</span>
            <span className="hidden shrink-0 label-caps text-[11px] text-muted sm:inline">{SHAPES[entry.set.shape]}</span>
            <button type="button" onClick={leave} aria-label="Close" className="rounded-control p-1 text-muted hover:bg-zinc-500/10 hover:text-zinc-900 active:scale-[0.97] dark:hover:text-zinc-100">
              <X className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[var(--surface-2)] p-3">
                <div className="relative max-w-full">
                  <img
                    src={entry.src}
                    alt={entry.shot.caption}
                    onClick={pinAt}
                    className={cx("block max-h-[calc(96vh-150px)] w-auto max-w-full object-contain", editable && "cursor-crosshair")}
                  />
                  {threads.pins.map((t, i) => (
                    <PinMark
                      key={targetKey(t)}
                      pin={t.pin!}
                      label={String(i + 1)}
                      active={shotComposer?.key === targetKey(t) || focused === targetKey(t)}
                      onClick={() => showPin(targetKey(t))}
                    />
                  ))}
                </div>
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
                  <span className="flex flex-wrap gap-x-1" onClickCapture={leave}>
                    {entry.shot.refs.map((r) => (
                      <RefLink key={`${r.path}:${r.line ?? ""}`} refTo={r} keep={2} />
                    ))}
                  </span>
                )}
              </div>
            </div>
            <ShotComments entry={entry} threads={threads} onPinFocus={setFocused} />
          </div>
        </div>
      )}
    </dialog>
  );
};

// The folded view: every set's pictures in one row that scrolls sideways, the set's title above its own.
const Strip = ({
  run,
  entries,
  busy,
  onOpen,
  onComment,
}: {
  run: ScreenshotsRun;
  entries: Entry[];
  busy: boolean;
  onOpen: (index: number, el: HTMLElement) => void;
  onComment: (index: number, el: HTMLElement) => void;
}) => (
  <Card className="px-3 py-3 sm:px-4">
    <ol className="flex gap-5 overflow-x-auto pb-1">
      {run.sets.map((set) => (
        <li key={set.id} className="shrink-0">
          <span className="mb-1.5 block truncate text-xs text-muted" title={set.title}>
            {set.title}
          </span>
          <ol className="flex gap-2">
            {set.shots.map((shot, n) => {
              const index = entries.findIndex((e) => e.shot === shot);
              const label = `${set.shape === "flow" ? `Step ${n + 1}: ` : ""}${shot.caption}`;
              return (
                <li key={shot.id} className="group/shot relative w-36 shrink-0">
                  {index >= 0 ? (
                    <>
                      <button
                        type="button"
                        title={label}
                        aria-label={`Open screenshot: ${label}`}
                        onClick={(e) => onOpen(index, e.currentTarget)}
                        className="group block w-full overflow-hidden border border-[var(--border)] bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <img src={entries[index].src} alt={shot.caption} loading="lazy" className="aspect-[16/10] w-full object-cover object-top transition-opacity group-hover:opacity-90" />
                      </button>
                      <CommentButton file={shot.file!} onComment={(el) => onComment(index, el)} />
                    </>
                  ) : (
                    <span title={shot.error ?? label} className="flex aspect-[16/10] w-full items-center justify-center border border-[var(--border)] bg-[var(--surface-2)]">
                      {busy && shot.status === "pending" ? (
                        <Loader2 className="size-4 animate-spin text-agent-500" />
                      ) : (
                        <ImageOff className={cx("size-4", shot.status === "failed" ? "text-danger-500" : "text-faint")} />
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  </Card>
);

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
  const [open, setOpenState] = useState(() => storage.get<boolean>(PREF_KEYS.screenshotsOpen, false));
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    storage.set(PREF_KEYS.screenshotsOpen, next);
  };
  const { openComposer } = useReview();
  const openAt = (index: number, el: HTMLElement) => {
    opener.current = el;
    setAt(index);
  };
  const commentAt = (index: number, el: HTMLElement) => {
    openAt(index, el);
    const entry = entries[index];
    if (entry) openComposer(shotTarget(entry.set, entry.shot));
  };

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

  // A screenshot comment picked in the review bar's list opens its picture here, or the section when that picture is
  // not in this round.
  useEffect(() => {
    const show = (e: Event) => {
      const index = entries.findIndex((entry) => entry.shot.file === (e as CustomEvent<string>).detail);
      opener.current = null;
      if (index >= 0) setAt(index);
      else document.getElementById("screenshots")?.scrollIntoView({ block: "start" });
    };
    window.addEventListener(SHOW_SHOT_EVENT, show);
    return () => window.removeEventListener(SHOW_SHOT_EVENT, show);
  }, [entries]);

  if (!run) return null;
  const busy = run.status === "running" || run.status === "preparing";

  return (
    <div id="screenshots">
      <SectionTitle
        right={
          <span className="inline-flex items-center gap-3">
            <span className="text-xs text-muted">{summaryOf(run)}</span>
            {run.sets.length > 0 && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls="screenshots-body"
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-500/10 active:scale-[0.97] dark:text-zinc-400"
              >
                {open ? "Collapse" : "Expand"}
                <ChevronDown className={cx("size-3.5 transition-transform", open && "rotate-180")} />
              </button>
            )}
          </span>
        }
      >
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

      <div id="screenshots-body">
        {!open && run.sets.length > 0 && <Strip run={run} entries={entries} busy={busy} onOpen={openAt} onComment={commentAt} />}
        {open && (
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
                        onOpen={(el) => openAt(index, el)}
                        onComment={(el) => commentAt(index, el)}
                      />
                    );
                  })}
                </ol>
              </Card>
            ))}
          </div>
        )}
      </div>
      <Lightbox entries={entries} at={at !== null && at < entries.length ? at : null} onMove={setAt} onClose={close} />
    </div>
  );
};
