import { CircleCheck, ClipboardCopy, ListChecks, ListOrdered, Loader2, MessageCircleQuestion, MessageSquarePlus, Send, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CommentTarget, ReviewComment } from "../../../skill/schema/types";
import { useAgent } from "../lib/agent";
import { COMMENT_KINDS } from "../lib/meta";
import { describeTarget, targetKey, useReview } from "../lib/review";
import { useReport } from "../lib/state";
import { Composer } from "./Comments";
import { PlanPanel } from "./PlanPanel";
import { RichText } from "./RichText";
import { cx, Kbd, KEY_LABELS, MOD_KEY, Meter, Pill } from "./ui";

const REPORT_TARGET: CommentTarget = { type: "report" };

// The bar floats above the page instead of running edge to edge, so it reads as a control and not as a footer.
// Its wrapper repeats the page container (max-w-[1440px] px-4 sm:px-6, as in App.tsx and the top bar), so the bar
// is exactly as wide as the sidebar and the content together, at every window size.
const floating = "pointer-events-none fixed inset-x-0 bottom-4 z-40 mx-auto max-w-[1440px] px-4 sm:px-6";
const panel = "pointer-events-auto w-full overflow-hidden rounded-control border border-[var(--border)] bg-[var(--surface)]/95 shadow-float backdrop-blur";

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

// How a new session of the agent picks a review up, for example after the one that made it ended. What to type
// depends on the agent, so the words come from it (lib/agent.ts).
const ResumeHint = ({ text }: { text: string }) => {
  const agent = useAgent();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agent.resumeCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The command is on screen to type by hand.
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-amber-700 dark:text-amber-400">
      {text} {agent.resumeLead}
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="inline-flex items-center gap-1 rounded-control bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-amber-500/25 ring-inset hover:bg-amber-500/20"
      >
        {agent.resumeCommand}
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
  const agent = useAgent();
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
  // A draft page: the agent is still writing the report and starts listening once it is published.
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
            ? `Review finished. ${agent.Name} handled all ${total} ${total === 1 ? "comment" : "comments"} without changing code, so there is no new round. ${agent.Name} can open the PR now.`
            : `Review finished. ${agent.Name} can open the PR now.`
          : review.phase === "sent" && unheard
            ? `Sent round ${round} with ${total} ${total === 1 ? "comment" : "comments"}.`
            : review.phase === "sent"
            ? `Sent round ${round} with ${total} ${total === 1 ? "comment" : "comments"}. ${agent.Name} is reading them and will post a plan here.`
            : review.phase === "planning"
              ? `${agent.Name}'s plan is ready. Approve it, or ask for a new one.`
              : `${agent.Name} is working: ${done} of ${total} done.`;
    const Icon = review.phase === "planning" ? ListOrdered : review.phase === "done" || review.latestRound > round ? CircleCheck : Loader2;

    return (
      <div className={floating}>
        <div className={cx(panel, "rise")}>
          {review.phase === "planning" && review.plan && review.latestRound === round && (
            <div className="max-h-[55vh] overflow-auto border-b border-[var(--border)] px-4 py-3">
              <PlanPanel />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
          <Icon className={cx("size-4", Icon === Loader2 ? "animate-spin text-violet-500" : Icon === ListOrdered ? "text-violet-500" : "text-emerald-500")} />
          <span>{message}</span>
          {review.phase === "working" && total > 0 && (
            <Meter value={done} total={total} fill="bg-emerald-500" className="h-1.5 w-32" />
          )}
          {unheard && <ResumeHint text={`No ${agent.noun} session is listening for this review.`} />}
          {stale && <ResumeHint text={`No update from ${agent.name} for 10 minutes. If its session ended,`} />}
          {!review.connected && <span className="text-xs text-red-600 dark:text-red-400">Not connected to the review server.</span>}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          </div>
        </div>
      </div>
    );
  }

  const copy = async () => {
    setCopied(await review.copyForAgent());
    window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className={floating}>
      <div className={panel}>
      {(listOpen || composingGeneral) && (
        <div className="max-h-[45vh] overflow-auto border-b border-[var(--border)] px-4 py-3">
          {composingGeneral && <Composer target={REPORT_TARGET} placeholder="A comment about the whole change" />}
          {listOpen && (
            <ul className="space-y-1.5">
              {!comments.length && <li className="text-sm text-zinc-500">No comments yet.</li>}
              {comments.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  <Pill className={cx("mt-px shrink-0 px-2 py-0 text-[10px]", c.kind ? COMMENT_KINDS[c.kind].className : "bg-zinc-500/10 text-zinc-500 ring-zinc-500/25")}>
                    {c.kind ? COMMENT_KINDS[c.kind].label : `${agent.Name} decides`}
                  </Pill>
                  <button type="button" onClick={() => goTo(c)} className="shrink-0 font-mono text-xs text-zinc-500 hover:underline">
                    {describeTarget(c.target)}
                  </button>
                  <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">
                    {c.text ? <RichText text={c.text} /> : <span className="text-zinc-400">{c.kind === "accepted" ? "Fine as it is" : "Do the suggested fix"}</span>}
                  </span>
                  <button type="button" onClick={() => review.remove(c.id)} className="shrink-0 rounded-control p-0.5 text-zinc-400 hover:bg-zinc-500/10" title="Delete">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm">
        {/* One chip for the risks and gaps: how many still wait for a decision. It also says when LGTM is honest. */}
        {problems.length > 0 && (
          <span
            title={`${problems.length} risks and gaps: ${queued} to fix, ${fine} fine, ${open} not decided`}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-control px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset tabular-nums",
              open > 0 ? "bg-amber-500/[0.08] text-amber-700 ring-amber-500/25 dark:text-amber-300" : "bg-emerald-500/[0.08] text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
            )}
          >
            {open > 0 ? <TriangleAlert className="size-3.5" /> : <CircleCheck className="size-3.5" />}
            {open > 0 ? `${open} of ${problems.length} ${problems.length === 1 ? "risk" : "risks"} not decided` : `All ${problems.length} ${problems.length === 1 ? "risk" : "risks"} decided`}
          </span>
        )}
        <button
          type="button"
          onClick={() => setListOpen(!listOpen)}
          className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
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
          className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
        >
          <MessageSquarePlus className="size-3.5" />
          General comment
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        {mode === "server" && !review.connected && <span className="text-xs text-red-600 dark:text-red-400">Not connected to the review server.</span>}
        {unheard && <ResumeHint text={`No ${agent.noun} session is listening, so your questions and requests wait.`} />}

        <span className="ml-auto inline-flex items-center gap-3">
          {mode === "server" ? (
            <>
              <span className={cx("text-[11px] text-zinc-400", saveState === "saved" && "fade-out")}>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
              <button
                type="button"
                onClick={review.submit}
                disabled={draft}
                title={
                  draft
                    ? `${agent.Name} is still writing the notes. Your comments are saved meanwhile.`
                    : comments.length
                      ? `Send your comments to ${agent.name} (${KEY_LABELS[MOD_KEY]}+Enter)`
                      : `Looks good to me: tell ${agent.name} the review is done, with no comments (${KEY_LABELS[MOD_KEY]}+Enter)`
                }
                className="inline-flex items-center gap-1.5 rounded-control bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {draft ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                {draft ? `${agent.Name} is writing the notes` : comments.length ? `Send ${comments.length} to ${agent.name}` : "LGTM"}
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
                className="inline-flex items-center gap-1.5 rounded-control bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
              >
                <ClipboardCopy className="size-3.5" />
                {copied ? `Copied. Paste it to ${agent.name}` : `Copy for ${agent.name}`}
              </button>
            </>
          )}
        </span>
      </div>
      </div>
    </div>
  );
};
