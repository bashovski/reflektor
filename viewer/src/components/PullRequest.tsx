import { ExternalLink, GitMerge } from "lucide-react";
import type { PrState } from "../../../skill/schema/types";
import { PR_STATES } from "../lib/meta";
import { usePr } from "../lib/pr";
import { cx, Pill } from "./ui";

// The pull request's state as a small pill: Open, Merged or Closed, with GitHub's icon and color.
export const PrStatePill = ({ state, className }: { state: PrState; className?: string }) => {
  const meta = PR_STATES[state];
  const Icon = meta.icon;
  return (
    <Pill className={cx(meta.pill, className)}>
      <Icon className="size-3" />
      {meta.label}
    </Pill>
  );
};

// Once the pull request is merged, the page says so at the top: the review is over.
export const MergedBanner = () => {
  const pr = usePr();
  if (pr?.state !== "MERGED") return null;
  const when = pr.mergedAt ? new Date(pr.mergedAt).toLocaleString() : null;
  return (
    <div className="border-b border-violet-500/30 bg-violet-50 dark:bg-violet-950/60">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm sm:px-6">
        <GitMerge className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="font-medium">
          Pull request #{pr.number} was merged{pr.base ? ` into ${pr.base}` : ""}
          {when ? ` on ${when}` : ""}.
        </span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 px-2.5 py-1 text-xs font-medium hover:bg-violet-500/10"
        >
          View on GitHub <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
};
