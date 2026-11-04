import { CircleAlert } from "lucide-react";
import { BEFORE_MERGE } from "../lib/meta";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { RefLink } from "./ui";

export const BeforeMerge = () => {
  const { bundle } = useReport();
  const items = bundle.report.beforeMerge;
  if (!items.length) return null;

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
        <CircleAlert className="size-4" />
        Before you merge
      </h2>
      <ul className="space-y-2">
        {items.map((item, i) => {
          const meta = BEFORE_MERGE[item.kind];
          const Icon = meta.icon;
          return (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 inline-flex w-28 shrink-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <Icon className="size-3.5" />
                {meta.label}
              </span>
              <RichText text={item.text} className="block min-w-0 flex-1 leading-relaxed" />
              {item.ref && <RefLink refTo={item.ref} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
