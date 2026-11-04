import { CircleCheck, ClipboardCopy, ListChecks, MessageSquarePlus, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { CommentTarget, ReviewComment } from "../../../skill/schema/types";
import { COMMENT_KINDS } from "../lib/meta";
import { describeTarget, targetKey, useReview } from "../lib/review";
import { useReport } from "../lib/state";
import { Composer } from "./Comments";
import { RichText } from "./RichText";
import { cx, Pill } from "./ui";

const REPORT_TARGET: CommentTarget = { type: "report" };

// Every risk, gap and flow error is a problem the reviewer should decide on.
const useProblems = () => {
  const { bundle } = useReport();
  return useMemo(() => {
    const keys: string[] = [];
    for (const s of bundle.report.sections)
      s.highlights.forEach((h, i) => {
        if (h.kind === "risk" || h.kind === "gap") keys.push(targetKey({ type: "highlight", section: s.kind, index: i, kind: h.kind, text: h.text }));
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
    default:
      return null;
  }
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
  const [listOpen, setListOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { comments, mode, sent, round, saveState, error, composer } = review;

  const decidedKinds = new Map(comments.map((c) => [targetKey(c.target), c.kind]));
  const queued = problems.filter((k) => decidedKinds.has(k) && decidedKinds.get(k) !== "accepted").length;
  const fine = problems.filter((k) => decidedKinds.get(k) === "accepted").length;
  const open = problems.length - queued - fine;
  const composingGeneral = composer?.key === "report" && !composer.editingId;

  if (sent) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        <div className="mx-auto flex max-w-[1440px] items-center gap-2">
          <CircleCheck className="size-4" />
          Sent to Claude as review round {round} ({comments.length} comments). Claude is reading them now. You can close this tab.
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
        <button
          type="button"
          onClick={() => review.openComposer(REPORT_TARGET)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
        >
          <MessageSquarePlus className="size-3.5" />
          General comment
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}

        <span className="ml-auto inline-flex items-center gap-3">
          {mode === "server" ? (
            <>
              <span className="text-[11px] text-zinc-400">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
              <button
                type="button"
                onClick={review.submit}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
              >
                <Send className="size-3.5" />
                {comments.length ? `Send ${comments.length} to Claude` : "Looks good, tell Claude"}
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
