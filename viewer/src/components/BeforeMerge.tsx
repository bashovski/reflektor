import { CircleAlert, CircleCheck } from "lucide-react";
import type { CommentTarget } from "../../../skill/schema/types";
import { BEFORE_MERGE } from "../lib/meta";
import { QuickActions, TargetComments } from "./Comments";
import { useMerged } from "../lib/pr";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { cx, RefLink } from "./ui";

export const BeforeMerge = () => {
  const { bundle } = useReport();
  // Once the pull request is merged, these are behind us: shown done, with nothing left to ask for.
  const merged = useMerged();
  const items = bundle.report.beforeMerge;
  if (!items.length) return null;

  return (
    <section className={cx("rounded-xl border p-4 sm:p-5", merged ? "border-violet-500/30 bg-violet-500/[0.06]" : "border-amber-500/30 bg-amber-500/[0.06]")}>
      <h2 className={cx("mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold", merged ? "text-violet-800 dark:text-violet-300" : "text-amber-800 dark:text-amber-300")}>
        {merged ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
        Before you merge
        {merged && <span className="font-normal text-zinc-500">Merged, so these are done.</span>}
      </h2>
      <ul className="space-y-2">
        {items.map((item, i) => {
          const meta = BEFORE_MERGE[item.kind];
          const Icon = merged ? CircleCheck : meta.icon;
          const target: CommentTarget = { type: "before-merge", index: i, text: item.text };
          return (
            <li key={i} id={`bm-${i}`} className="group/row flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
              <span className={cx("mt-0.5 inline-flex w-28 shrink-0 items-center gap-1.5 text-xs font-medium", merged ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                <Icon className="size-3.5" />
                {meta.label}
              </span>
              <div className="min-w-[min(10rem,100%)] flex-1">
                <RichText text={item.text} className={cx("block leading-relaxed", merged && "text-zinc-500 line-through decoration-zinc-400")} />
                {!merged && <QuickActions target={target} variant="todo" />}
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
