import { MessagesSquare } from "lucide-react";
import { useAgent } from "../lib/agent";
import { COMMENT_KINDS, REPLY_STATUS } from "../lib/meta";
import { describeTarget } from "../lib/review";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { cx, Pill, RefLink } from "./ui";

// The comments from the last review round, each with the agent's reply.
export const PreviousReview = () => {
  const { bundle } = useReport();
  const agent = useAgent();
  const previous = bundle.previousReview;
  const replies = bundle.report.review?.replies ?? [];
  if (!previous) return null;

  const replyFor = new Map(replies.map((r) => [r.commentId, r]));
  const done = previous.comments.filter((c) => replyFor.get(c.id)?.status === "fixed").length;

  return (
    <section className="surface border p-4 sm:p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <MessagesSquare className="size-4 text-blue-500" />
        Your review, round {previous.round}
      </h2>
      <p className="mb-3 text-xs text-zinc-500">
        {previous.comments.length} {previous.comments.length === 1 ? "comment" : "comments"}, {done} fixed.{" "}
        {bundle.diff.sinceRound ? "The changes below can show what changed since that review, or the whole branch." : "The changes below are only what changed since that review."}
      </p>
      <ul className="divide-y divide-[var(--border)]">
        {previous.comments.map((c) => {
          const reply = replyFor.get(c.id);
          return (
            <li key={c.id} className="grid gap-1.5 py-2.5 text-sm sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4">
              <div className="min-w-0">
                <p className="mb-0.5 truncate font-mono text-[11px] text-zinc-500" title={describeTarget(c.target)}>
                  {describeTarget(c.target)}
                </p>
                <div className="flex items-start gap-1.5">
                  {c.kind && <Pill className={cx("mt-px shrink-0 px-1.5 py-0 text-[10px]", COMMENT_KINDS[c.kind].className)}>{COMMENT_KINDS[c.kind].label}</Pill>}
                  <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
                    {c.text ? <RichText text={c.text} /> : c.kind === "accepted" ? "Fine as it is" : "Do the suggested fix"}
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                {reply ? (
                  <>
                    <Pill className={cx("mt-px shrink-0 px-2 py-0 text-[10px]", REPLY_STATUS[reply.status].className)}>{REPLY_STATUS[reply.status].label}</Pill>
                    <RichText text={reply.text} className="block min-w-[min(10rem,100%)] flex-1 text-zinc-700 dark:text-zinc-300" />
                    {reply.ref && <RefLink refTo={reply.ref} className="ml-auto" />}
                  </>
                ) : (
                  <span className="text-xs text-amber-600 dark:text-amber-400">{agent.Name} did not reply to this comment.</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
