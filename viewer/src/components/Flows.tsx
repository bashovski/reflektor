import { ChevronRight, CircleHelp, Route } from "lucide-react";
import { useState } from "react";
import type { Bundle, CommentTarget } from "../../../skill/schema/types";
import { QuickActions, SuggestedFix, TargetComments } from "./Comments";
import { FLOW_DETAILS, STEP_STATUS } from "../lib/meta";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { Card, cx, Pill, RefLink, SectionTitle } from "./ui";

type FlowData = Bundle["report"]["flows"][number];

const FlowTrace = ({ flow }: { flow: FlowData }) => {
  const [open, setOpen] = useState(false);
  const newCount = flow.steps.filter((s) => s.status !== "existing").length;

  return (
    <Card className="overflow-hidden" id={`flow-${flow.id}`}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-zinc-500/[0.04] sm:px-5">
        <ChevronRight className={cx("mt-0.5 size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{flow.title}</span>
            <span className="text-xs text-zinc-500">
              {flow.steps.length} steps, {newCount} new or changed
            </span>
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">{flow.trigger}</p>
        </div>
      </button>

      {open && (
        <ol className="border-t border-[var(--border)] px-4 py-4 sm:px-5">
          {flow.steps.map((step, i) => {
            const status = STEP_STATUS[step.status];
            const last = i === flow.steps.length - 1;
            return (
              <li key={i} className="grid grid-cols-[88px_20px_1fr] gap-x-2 sm:grid-cols-[112px_20px_1fr]">
                <span className="pt-[3px] text-right text-[11px] font-medium uppercase tracking-wide text-zinc-500">{step.layer}</span>
                <span className="relative flex justify-center">
                  <span className={cx("relative z-10 mt-[7px] size-2.5 rounded-full border-2", status.node)} />
                  {!last && <span className="absolute top-[18px] bottom-[-7px] w-px bg-zinc-300 dark:bg-zinc-700" />}
                </span>
                <div className={cx("min-w-0", !last && "pb-4")}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code className="font-mono text-[13px] font-medium">{step.symbol}</code>
                    <Pill className={cx("px-1.5 py-0 text-[10px] uppercase tracking-wide", status.className)}>{status.label}</Pill>
                    {!step.verified && (
                      <span title="The build could not find this name in the file" className="inline-flex items-center gap-1 text-[11px] text-amber-600">
                        <CircleHelp className="size-3" /> unverified
                      </span>
                    )}
                    <span className="ml-auto">{step.ref && <RefLink refTo={step.ref} keep={2} />}</span>
                  </div>
                  {step.details && step.details.length > 0 && (
                    <ul className="mt-1.5 space-y-1 border-l border-dashed border-zinc-300 pl-3 dark:border-zinc-700">
                      {step.details.map((d, di) => {
                        const meta = FLOW_DETAILS[d.kind];
                        const Icon = meta.icon;
                        const target: CommentTarget = { type: "flow-detail", flow: flow.id, step: i, detail: di, symbol: step.symbol, text: d.text, fix: d.fix };
                        return (
                          <li key={di} className="group/row flex items-start gap-2 text-[13px] leading-snug">
                            <Icon className={cx("mt-[2px] size-3.5 shrink-0", meta.className)} />
                            <div className="min-w-0 flex-1">
                              <RichText text={d.text} className={cx("block", d.kind === "error" ? "text-red-700 dark:text-red-300" : "text-zinc-600 dark:text-zinc-400")} />
                              {d.fix && <SuggestedFix text={d.fix} className="mt-1" />}
                              <QuickActions target={target} variant={d.kind === "error" ? "problem" : "info"} />
                              <TargetComments target={target} />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
};

export const Flows = () => {
  const { bundle } = useReport();
  const flows = bundle.report.flows;
  if (!flows.length) return null;

  return (
    <div id="flows">
      <SectionTitle
        right={
          <span className="hidden items-center gap-3 text-[11px] text-zinc-500 sm:inline-flex">
            {(["new", "changed", "existing"] as const).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cx("size-2 rounded-full border-2", STEP_STATUS[s].node)} />
                {STEP_STATUS[s].label}
              </span>
            ))}
          </span>
        }
      >
        <span className="inline-flex items-center gap-2">
          <Route className="size-4" /> How it works
        </span>
      </SectionTitle>
      <div className="space-y-3">
        {flows.map((flow) => (
          <FlowTrace key={flow.id} flow={flow} />
        ))}
      </div>
    </div>
  );
};
