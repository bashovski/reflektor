import { Check, Loader2, MessageCircleQuestion, MessageSquarePlus, Pencil, Sparkles, Trash2, Undo2, Wrench } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { CommentKind, CommentTarget, LiveQuestion, ReviewComment } from "../../../skill/schema/types";
import { type Agent, useAgent } from "../lib/agent";
import { COMMENT_KINDS, REPLY_STATUS } from "../lib/meta";
import { describeTarget, targetKey, useReview } from "../lib/review";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { cx, Pill, RefLink } from "./ui";

const button =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";
const ghost = `${button} text-zinc-600 hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100`;
const primary = `${button} bg-blue-600 text-white hover:bg-blue-700`;

export const SuggestedFix = ({ text, className }: { text: string; className?: string }) => (
  <div className={cx("flex items-start gap-1.5 text-[13px] text-zinc-500", className)}>
    <Wrench className="mt-[3px] size-3 shrink-0" />
    <span className="min-w-0">
      <span className="font-medium text-zinc-600 dark:text-zinc-400">Suggested fix: </span>
      <RichText text={text} />
    </span>
  </div>
);

export const Composer = ({ target, placeholder }: { target: CommentTarget; placeholder?: string }) => {
  const { composer, comments, add, update, closeComposer, mode, ask } = useReview();
  const editing = composer?.editingId ? comments.find((c) => c.id === composer.editingId) : undefined;
  // While the page is a draft, the agent is still writing the report and not answering yet.
  const draft = Boolean(useReport().bundle.draft);
  const agent = useAgent();
  const canAsk = mode === "server" && !editing && composer?.kind !== "decision" && !draft;
  const [text, setText] = useState(editing?.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const save = () => {
    const clean = text.trim();
    if (editing) update(editing.id, { text: clean });
    else if (clean) add(target, { text: clean, kind: composer?.kind });
    closeComposer();
  };

  const askNow = () => {
    const clean = text.trim();
    if (clean) void ask(target, clean);
    closeComposer();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
    if (e.key === "Escape") closeComposer();
  };

  return (
    <div className="my-1.5 rounded-lg border border-blue-500/40 bg-[var(--surface)] p-2.5 font-sans" onClick={(e) => e.stopPropagation()}>
      <p className="mb-1.5 text-[11px] text-zinc-500">{describeTarget(target)}</p>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        placeholder={placeholder ?? "What should change, or what do you want to know?"}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-[13px] leading-relaxed outline-none placeholder:text-zinc-400 focus:border-blue-500"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="hidden text-[11px] text-zinc-400 sm:inline">
          {canAsk ? `Ask now: ${agent.name} answers while you review. Add comment: saved until you send the review.` : <>Start with <code>nit:</code> or <code>q:</code> to mark it, or let {agent.name} decide. ⌘↵ saves.</>}
        </span>
        <span className="ml-auto" />
        <button type="button" onClick={closeComposer} className={ghost}>
          Cancel
        </button>
        {canAsk && (
          <button type="button" onClick={askNow} className={cx(ghost, "border border-violet-500/40 text-violet-700 dark:text-violet-300")} disabled={!text.trim()}>
            <MessageCircleQuestion className="size-3.5" /> Ask {agent.name} now
          </button>
        )}
        <button type="button" onClick={save} className={primary} disabled={!editing && !text.trim()}>
          {editing ? "Save" : "Add comment"}
        </button>
      </div>
    </div>
  );
};

const kindLabel = (c: ReviewComment, agent: Agent) => {
  if (c.kind === "fix" && !c.text) return "Fix as suggested";
  if (c.kind === "accepted") return "It's fine";
  return c.kind ? COMMENT_KINDS[c.kind].label : `${agent.Name} decides the kind`;
};

// The agent's progress on a sent comment, streamed live from the daemon.
export const CommentStatusLine = ({ commentId }: { commentId: string }) => {
  const { statusOf } = useReview();
  const agent = useAgent();
  const status = statusOf(commentId);
  if (!status) return null;
  if (status.status === "working") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
        <Loader2 className="size-3 animate-spin" /> {agent.Name} is working on this
      </p>
    );
  }
  const meta = REPLY_STATUS[status.status];
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-[var(--border)] pt-1.5 text-[13px]">
      <Pill className={cx("mt-px shrink-0 px-2 py-0 text-[10px]", meta.className)}>{meta.label}</Pill>
      {status.text && <RichText text={status.text} className="block min-w-[min(10rem,100%)] flex-1" />}
      {status.ref && <RefLink refTo={status.ref} className="ml-auto" />}
    </div>
  );
};

export const CommentItem = ({ comment, compact }: { comment: ReviewComment; compact?: boolean }) => {
  const agent = useAgent();
  const { editable, openComposer, remove, composer } = useReview();
  if (composer?.editingId === comment.id) return <Composer target={comment.target} />;
  const tone = comment.kind ? COMMENT_KINDS[comment.kind].className : "bg-zinc-500/10 text-zinc-500 ring-zinc-500/25";

  return (
    <div className={cx("group/comment flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] font-sans", compact ? "px-2 py-1.5" : "my-1.5 px-3 py-2")}>
      <Pill className={cx("mt-px shrink-0 px-2 py-0 text-[10px]", tone)}>{kindLabel(comment, agent)}</Pill>
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        {comment.text ? <RichText text={comment.text} /> : null}
        <CommentStatusLine commentId={comment.id} />
      </div>
      {editable && (
        <span className="flex shrink-0 gap-0.5 opacity-60 group-hover/comment:opacity-100">
          <button type="button" title="Edit" onClick={() => openComposer(comment.target, { editingId: comment.id })} className="rounded p-1 hover:bg-zinc-500/10">
            <Pencil className="size-3" />
          </button>
          <button type="button" title="Delete" onClick={() => remove(comment.id)} className="rounded p-1 hover:bg-zinc-500/10">
            <Trash2 className="size-3" />
          </button>
        </span>
      )}
    </div>
  );
};

// A live question and, once it arrives, the agent's answer.
export const QuestionThread = ({ question }: { question: LiveQuestion }) => {
  const [slow, setSlow] = useState(false);
  const agent = useAgent();
  useEffect(() => {
    if (question.answer) return;
    const timer = window.setTimeout(() => setSlow(true), 90_000 - (Date.now() - Date.parse(question.askedAt)));
    return () => window.clearTimeout(timer);
  }, [question]);

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.05] px-3 py-2 font-sans text-[13px] leading-snug">
      <p className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
        <span>
          <span className="font-medium">You asked: </span>
          {question.text}
        </span>
      </p>
      {question.answer ? (
        <div className="mt-1.5 flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-violet-500/20 pt-1.5">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
          <RichText text={question.answer.text} className="block min-w-[min(10rem,100%)] flex-1" />
          {question.answer.ref && <RefLink refTo={question.answer.ref} className="ml-auto" />}
        </div>
      ) : (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
          <Loader2 className="size-3 animate-spin" />
          {slow ? `${agent.Name} has not picked this up yet. Is the ${agent.noun} session still open?` : `Waiting for ${agent.name}…`}
        </p>
      )}
    </div>
  );
};

// Saved comments and the open composer for one target.
export const TargetComments = ({ target, placeholder }: { target: CommentTarget; placeholder?: string }) => {
  const { commentsFor, composer, questionsFor } = useReview();
  // One-click decisions without a note are shown by QuickActions, not as a comment.
  const list = commentsFor(target).filter((c) => c.text || composer?.editingId === c.id || (c.kind !== "fix" && c.kind !== "accepted"));
  const asked = questionsFor(target);
  const composing = composer?.key === targetKey(target) && !composer.editingId;
  if (!list.length && !composing && !asked.length) return null;
  return (
    <div className="mt-1.5 space-y-1.5">
      {asked.map((q) => (
        <QuestionThread key={q.id} question={q} />
      ))}
      {list.map((c) => (
        <CommentItem key={c.id} comment={c} compact />
      ))}
      {composing && <Composer target={target} placeholder={placeholder} />}
    </div>
  );
};

// Buttons on rows that describe a problem (risk, gap, flow error) or a to-do (before merge).
export const QuickActions = ({
  target,
  variant,
  labels,
}: {
  target: CommentTarget;
  variant: "problem" | "todo" | "info";
  labels?: { fix: string; fine: string; queued: string; accepted: string };
}) => {
  const { editable, commentsFor, add, remove, openComposer } = useReview();
  const agent = useAgent();
  const existing = commentsFor(target);
  const decided = existing.find((c) => c.kind === "fix" || c.kind === "accepted");

  if (decided) {
    return (
      <div className="mt-1">
        <div className="flex flex-wrap items-center justify-end gap-1">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5" />
            {decided.kind === "accepted"
              ? (labels?.accepted ?? "Marked as fine")
              : (labels?.queued ?? (variant === "todo" ? `Queued for ${agent.name}` : "Queued: fix as suggested"))}
          </span>
          {editable && !decided.text && (
            <button type="button" className={ghost} onClick={() => openComposer(target, { editingId: decided.id })}>
              <MessageSquarePlus className="size-3.5" /> Add a note
            </button>
          )}
          {editable && (
            <button type="button" className={ghost} onClick={() => remove(decided.id)}>
              <Undo2 className="size-3.5" /> Undo
            </button>
          )}
        </div>
        {!decided.text && <CommentStatusLine commentId={decided.id} />}
      </div>
    );
  }
  if (!editable) return null;

  const comment = (kind?: CommentKind) => () => openComposer(target, { kind });

  // Rows that are information only get a small floating button, so they keep their height.
  if (variant === "info") {
    return (
      <button
        type="button"
        title="Comment"
        onClick={comment()}
        className="absolute right-1.5 bottom-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 text-zinc-500 opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-zinc-900 focus:opacity-100 dark:hover:text-zinc-100"
      >
        <MessageSquarePlus className="size-3.5" />
      </button>
    );
  }

  // The decision sits at the right edge as one control, so a row reads as text on the left and a choice on the right.
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
      <button type="button" className={ghost} onClick={comment()}>
        <MessageSquarePlus className="size-3.5" /> Comment
      </button>
      <span className="inline-flex overflow-hidden rounded-md border border-[var(--border)] text-xs font-medium">
        <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1 text-blue-700 hover:bg-blue-600/10 dark:text-blue-300" onClick={() => add(target, { kind: "fix" })}>
          <Wrench className="size-3.5" /> {labels?.fix ?? (variant === "todo" ? "Do this" : "Fix this")}
        </button>
        {variant === "problem" && (
          <>
            <span aria-hidden className="w-px bg-[var(--border)]" />
            <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1 text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400" onClick={() => add(target, { kind: "accepted" })}>
              <Check className="size-3.5" /> {labels?.fine ?? "It's fine"}
            </button>
          </>
        )}
      </span>
    </div>
  );
};

export const commentButtonClass = ghost;
