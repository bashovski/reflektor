import { CircleCheck, ClipboardCopy, ListChecks, ListOrdered, Loader2, MessageCircleQuestion, MessageSquarePlus, Send, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CommentTarget, ReviewComment } from "../../../skill/schema/types";
import { COMMENT_KINDS } from "../lib/meta";
import { describeTarget, targetKey, useReview } from "../lib/review";
import { useReport } from "../lib/state";
import { Composer } from "./Comments";
import { PlanPanel } from "./PlanPanel";
import { RichText } from "./RichText";
import { cx, Kbd, KEY_LABELS, MOD_KEY, Pill } from "./ui";

const REPORT_TARGET: CommentTarget = { type: "report" };

// Every risk, gap, flow error and unfinished plan item is a problem the reviewer should decide on.
const useProblems = () => {
  const { bundle } = useReport();
  return useMemo(() => {
    const keys: string[] = [];
    for (const s of bundle.report.sections)
      s.highlights.forEach((h, i) => {
        if (h.kind === "risk" || h.kind === "gap") keys.push(targetKey({ type: "highlight", section: s.kind, index: i, kind: h.kind, text: h.text }));
      });
    bundle.report.plan?.items.forEach((item, i) => {
      if (item.status === "missing" || item.status === "partial") keys.push(targetKey({ type: "plan-item", index: i, status: item.status, text: item.text }));
    });
    for (const f of bundle.report.flows)
      f.steps.forEach((step, si) =>
        step.details?.forEach((d, di) => {
          if (d.kind === "error") keys.push(targetKey({ type: "flow-detail", flow: f.id, step: si, detail: di, symbol: step.symbol, text: d.text }));
        }),
      );
    return keys;
  }, [bundle]);
};

// DOM id of the row a non-code comment belongs to, plus the section that must be open to show it.
export const targetAnchor = (t: CommentTarget, sections: { kind: string }[]): { id: string; section?: number } | null => {
  const sectionIndex = "section" in t ? sections.findIndex((s) => s.kind === t.section) : -1;
  switch (t.type) {
    case "highlight":
      return { id: `hl-${sectionIndex}-${t.index}`, section: sectionIndex };
    case "question":
      return { id: `q-${sectionIndex}-${t.index}`, section: sectionIndex };
    case "flow-detail":
      return { id: `flow-${t.flow}` };
    case "before-merge":
      return { id: `bm-${t.index}` };
    case "plan-item":
      return { id: `plan-${t.index}` };
    default:
      return null;
  }
};

// A new Claude session picks up a review with this, for example after the one that made it ended.
const RESUME = "/pr-report resume";

const ResumeHint = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RESUME);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The command is on screen to type by hand.
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-amber-700 dark:text-amber-400">
      {text} In Claude Code, run
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-amber-500/25 ring-inset hover:bg-amber-500/20"
      >
        {RESUME}
        <ClipboardCopy className="size-3" />
      </button>
      {copied && <span className="text-zinc-500">Copied</span>}
    </span>
  );
};

export const ReviewBar = () => {
  const { bundle, jumpTo, setSectionOpen } = useReport();

  const goTo = (c: ReviewComment) => {
    const t = c.target;
    if (t.type === "line") return jumpTo({ path: t.path, line: t.end, side: t.side });
    if (t.type === "file") return jumpTo({ path: t.path });
    const anchor = targetAnchor(t, bundle.report.sections);
    if (!anchor) return;
    if (anchor.section !== undefined && anchor.section >= 0) setSectionOpen(anchor.section, true);
    requestAnimationFrame(() => document.getElementById(anchor.id)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const review = useReview();
  const problems = useProblems();
  // Re-render every 5 seconds so the warnings about a missing agent can appear without a new event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, []);
  const [listOpen, setListOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { comments, mode, sent, round, saveState, error, composer } = review;

  const decidedKinds = new Map(comments.map((c) => [targetKey(c.target), c.kind]));
  const queued = problems.filter((k) => decidedKinds.has(k) && decidedKinds.get(k) !== "accepted").length;
  const fine = problems.filter((k) => decidedKinds.get(k) === "accepted").length;
  const open = problems.length - queued - fine;
  const composingGeneral = composer?.key === "report" && !composer.editingId;
  // Something the reviewer sent has waited 15 seconds and no agent listens for it.
  // A draft page: Claude is still writing the report and starts listening once it is published.
  const draft = Boolean(bundle.draft);
  const unheard =
    !draft && mode === "server" && review.connected && !review.listening && review.undeliveredSince !== null && Date.now() - Date.parse(review.undeliveredSince) > 15_000;

  if (sent) {
    const total = comments.length;
    const done = comments.filter((c) => {
      const status = review.statusOf(c.id);
      return status && status.status !== "working";
    }).length;
    const quiet = review.lastAgentActivity ? Date.now() - Date.parse(review.lastAgentActivity) : 0;
    const stale = (review.phase === "working" || review.phase === "sent") && !unheard && quiet > 10 * 60_000;
    const message =
      review.latestRound > round
        ? `This is round ${round}. Round ${review.latestRound} is newer.`
        : review.phase === "done"
          ? total
            ? `Review finished. Claude handled all ${total} ${total === 1 ? "comment" : "comments"} without changing code, so there is no new round. Claude can open the PR now.`
            : "Review finished. Claude can open the PR now."
          : review.phase === "sent" && unheard
            ? `Sent round ${round} with ${total} ${total === 1 ? "comment" : "comments"}.`
            : review.phase === "sent"
            ? `Sent round ${round} with ${total} ${total === 1 ? "comment" : "comments"}. Claude is reading them and will post a plan here.`
            : review.phase === "planning"
              ? "Claude's plan is ready. Approve it, or ask for a new one."
              : `Claude is working: ${done} of ${total} done.`;
    const Icon = review.phase === "planning" ? ListOrdered : review.phase === "done" || review.latestRound > round ? CircleCheck : Loader2;

    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        {review.phase === "planning" && review.plan && review.latestRound === round && (
          <div className="mx-auto max-h-[55vh] max-w-[1440px] overflow-auto border-b border-[var(--border)] px-4 py-3 sm:px-6">
            <PlanPanel />
          </div>
        )}
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-6">
          <Icon className={cx("size-4", Icon === Loader2 ? "animate-spin text-violet-500" : Icon === ListOrdered ? "text-violet-500" : "text-emerald-500")} />
          <span>{message}</span>
          {review.phase === "working" && total > 0 && (
            <span className="h-1.5 w-32 overflow-hidden rounded-full bg-zinc-500/15">
              <span className="block h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </span>
          )}
          {unheard && <ResumeHint text="No Claude session is listening for this review." />}
          {stale && <ResumeHint text="No update from Claude for 10 minutes. If its session ended," />}
          {!review.connected && <span className="text-xs text-red-600 dark:text-red-400">Not connected to the review server.</span>}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>
    );
  }

  const copy = async () => {
    setCopied(await review.copyForClaude());
    window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
      {(listOpen || composingGeneral) && (
        <div className="mx-auto max-h-[45vh] max-w-[1440px] overflow-auto border-b border-[var(--border)] px-4 py-3 sm:px-6">
          {composingGeneral && <Composer target={REPORT_TARGET} placeholder="A comment about the whole change" />}
          {listOpen && (
            <ul className="space-y-1.5">
              {!comments.length && <li className="text-sm text-zinc-500">No comments yet.</li>}
              {comments.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  <Pill className={cx("mt-px shrink-0 px-2 py-0 text-[10px]", c.kind ? COMMENT_KINDS[c.kind].className : "bg-zinc-500/10 text-zinc-500 ring-zinc-500/25")}>
                    {c.kind ? COMMENT_KINDS[c.kind].label : "Claude decides"}
                  </Pill>
                  <button type="button" onClick={() => goTo(c)} className="shrink-0 font-mono text-xs text-zinc-500 hover:underline">
                    {describeTarget(c.target)}
                  </button>
                  <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">
                    {c.text ? <RichText text={c.text} /> : <span className="text-zinc-400">{c.kind === "accepted" ? "Fine as it is" : "Do the suggested fix"}</span>}
                  </span>
                  <button type="button" onClick={() => review.remove(c.id)} className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-500/10" title="Delete">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
        {problems.length > 0 && (
          <span className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">{problems.length} problems:</span>
            <span>{queued} to fix</span>
            <span>·</span>
            <span>{fine} fine</span>
            <span>·</span>
            <span className={cx(open > 0 && "font-medium text-amber-700 dark:text-amber-400")}>{open} not decided</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => setListOpen(!listOpen)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
        >
          <ListChecks className="size-3.5" />
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </button>
        {review.questions.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
            <MessageCircleQuestion className="size-3.5" />
            {review.questions.length} {review.questions.length === 1 ? "question" : "questions"}
            {review.questions.some((q) => !q.answer) && <span className="text-zinc-500">({review.questions.filter((q) => !q.answer).length} waiting)</span>}
          </span>
        )}
        <button
          type="button"
          onClick={() => review.openComposer(REPORT_TARGET)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
        >
          <MessageSquarePlus className="size-3.5" />
          General comment
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        {mode === "server" && !review.connected && <span className="text-xs text-red-600 dark:text-red-400">Not connected to the review server.</span>}
        {unheard && <ResumeHint text="No Claude session is listening, so your questions and requests wait." />}

        <span className="ml-auto inline-flex items-center gap-3">
          {mode === "server" ? (
            <>
              <span className="text-[11px] text-zinc-400">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
              <button
                type="button"
                onClick={review.submit}
                disabled={draft}
                title={
                  draft
                    ? "Claude is still writing the notes. Your comments are saved meanwhile."
                    : comments.length
                      ? `Send your comments to Claude (${KEY_LABELS[MOD_KEY]}+Enter)`
                      : `Looks good to me: tell Claude the review is done, with no comments (${KEY_LABELS[MOD_KEY]}+Enter)`
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {draft ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                {draft ? "Claude is writing the notes" : comments.length ? `Send ${comments.length} to Claude` : "LGTM"}
                {!draft && (
                  // aria-hidden keeps the button's name to its text; the keys are a hint for sighted users.
                  <span className="ml-0.5 inline-flex items-center gap-0.5" aria-hidden>
                    <Kbd name={MOD_KEY} className="h-[18px] min-w-[18px] border-white/25 bg-white/15 text-white shadow-none" />
                    <Kbd name="Enter" className="h-[18px] min-w-[18px] border-white/25 bg-white/15 text-white shadow-none" />
                  </span>
                )}
              </button>
            </>
          ) : (
            <>
              <span className="hidden text-[11px] text-zinc-400 md:inline">Opened as a file: comments stay in this browser.</span>
              <button
                type="button"
                onClick={copy}
                disabled={!comments.length}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-40"
              >
                <ClipboardCopy className="size-3.5" />
                {copied ? "Copied. Paste it to Claude" : "Copy for Claude"}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
};
