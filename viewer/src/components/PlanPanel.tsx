import { Check, ListOrdered, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useAgent } from "../lib/agent";
import { useReview } from "../lib/review";
import { RichText } from "./RichText";
import { cx } from "./ui";

const KINDS = [
  ["fix", "Fix"],
  ["question", "Answer only"],
  ["nit", "Nit, if cheap"],
  ["skip", "Skip"],
] as const;

// The agent's plan for the sent comments. The reviewer can change a step's kind, add a note,
// and approve it or ask for a new plan.
export const PlanPanel = () => {
  const { plan, comments, decidePlan } = useReview();
  const [kinds, setKinds] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = useAgent();
  if (!plan) return null;

  const decide = async (decision: "approve" | "changes") => {
    setBusy(true);
    await decidePlan(decision, kinds, note);
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ListOrdered className="size-4 text-agent-500" />
        <span className="font-semibold">
          {agent.Name}'s plan for your {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        <span className="text-xs text-zinc-500">Change a kind if {agent.name} read a comment wrong.</span>
      </div>
      {plan.note && <RichText text={plan.note} className="block text-sm text-zinc-600 dark:text-zinc-400" />}
      <ol className="space-y-1.5">
        {plan.steps.map((step, i) => {
          const kind = kinds[i] ?? step.kind;
          return (
            <li key={i} className={cx("grid grid-cols-[24px_minmax(0,180px)_130px_minmax(0,1fr)] items-start gap-3 text-sm", kind === "skip" && "opacity-50")}>
              <span className="num pt-1 text-right text-xs text-zinc-400">{i + 1}.</span>
              <span className="truncate pt-1 font-mono text-xs text-zinc-500" title={step.where}>
                {step.where}
              </span>
              <select
                value={kind}
                onChange={(e) => setKinds((prev) => ({ ...prev, [i]: e.target.value }))}
                className="rounded-control border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs"
              >
                {KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <RichText text={step.action} className={cx("block pt-0.5 leading-snug", kind === "skip" && "line-through")} />
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={1}
          placeholder="Anything to add? (optional)"
          className="min-w-[240px] flex-1 resize-y rounded-control border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[13px] outline-none focus:border-accent-500"
        />
        <button
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => decide("changes")}
          title="Write in the note what to change"
          className="inline-flex items-center gap-1.5 rounded-control border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-zinc-500/10 disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" /> Ask for a new plan
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide("approve")}
          className="inline-flex items-center gap-1.5 rounded-control bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-40"
        >
          <Check className="size-3.5" /> Go ahead
        </button>
      </div>
    </div>
  );
};
