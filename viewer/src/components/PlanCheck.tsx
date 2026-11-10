import { CircleCheck, CircleDashed, CircleDot, CirclePlus, ListChecks } from "lucide-react";
import type { CommentTarget, PlanStatus } from "../../../skill/schema/types";
import { type Agent, useAgent } from "../lib/agent";
import { useReport } from "../lib/state";
import { QuickActions, TargetComments } from "./Comments";
import { RichText } from "./RichText";
import { cx, RefLink } from "./ui";

const STATUS: Record<PlanStatus, { label: string; icon: typeof CircleCheck; className: string }> = {
  done: { label: "Done", icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400" },
  partial: { label: "Partly done", icon: CircleDot, className: "text-amber-600 dark:text-amber-400" },
  missing: { label: "Not done", icon: CircleDashed, className: "text-red-600 dark:text-red-400" },
  extra: { label: "Not in the plan", icon: CirclePlus, className: "text-violet-600 dark:text-violet-400" },
};

const planLabels = (agent: Agent) => ({ fix: "Finish it", fine: "Not needed", queued: `Queued: ${agent.name} finishes it`, accepted: "Marked as not needed" });

// Did the change do what this session planned?
export const PlanCheck = () => {
  const { bundle } = useReport();
  const agent = useAgent();
  const plan = bundle.report.plan;
  if (!plan?.items.length) return null;

  const planned = plan.items.filter((i) => i.status !== "extra");
  const done = planned.filter((i) => i.status === "done").length;
  const pct = planned.length ? Math.round((done / planned.length) * 100) : 100;

  return (
    <section id="plan" className="surface rounded-xl border p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="size-4 text-blue-500" />
          Plan check
        </h2>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          {done} of {planned.length} planned items done
        </span>
        <span className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-500/15">
          <span className={cx("block h-full rounded-full", pct === 100 ? "bg-emerald-500" : "bg-amber-500")} style={{ width: `${pct}%` }} />
        </span>
        <span className="w-full text-xs text-zinc-500">Plan: {plan.source}</span>
      </div>
      <ul className="space-y-1.5">
        {plan.items.map((item, i) => {
          const meta = STATUS[item.status];
          const Icon = meta.icon;
          const target: CommentTarget = { type: "plan-item", index: i, status: item.status, text: item.text };
          const unfinished = item.status === "missing" || item.status === "partial";
          return (
            <li key={i} id={`plan-${i}`} className="group/row relative flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-500/[0.04]">
              <span className={cx("mt-px inline-flex w-[118px] shrink-0 items-center gap-1.5 text-xs font-medium", meta.className)}>
                <Icon className="size-3.5" />
                {meta.label}
              </span>
              <div className="min-w-[min(10rem,100%)] flex-1">
                <RichText text={item.text} className="block leading-relaxed" />
                {item.note && <RichText text={item.note} className="block text-[13px] text-zinc-500" />}
                <QuickActions target={target} variant={unfinished ? "problem" : "info"} labels={unfinished ? planLabels(agent) : undefined} />
                <TargetComments target={target} />
              </div>
              {item.ref && <RefLink refTo={item.ref} className="ml-auto" />}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
