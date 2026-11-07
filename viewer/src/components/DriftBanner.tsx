import { RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useReview } from "../lib/review";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The daemon checks open reviews for code that changed after their report was built. The page says
// so, since the notes and line numbers may no longer match, and can ask the agent for an update.
export const DriftBanner = () => {
  const { drift, phase, mode, requestRefresh } = useReview();
  const [asked, setAsked] = useState(false);
  if (mode !== "server" || !drift || (phase !== "reviewing" && phase !== "done")) return null;

  const shown = drift.files.slice(0, 3).map((p) => p.split("/").at(-1));
  const more = drift.fileCount - shown.length;
  const what = drift.branch
    ? `You switched to ${drift.branch}.`
    : `${plural(drift.fileCount, "file")} changed after this report was built${drift.commits ? ` (${plural(drift.commits, "new commit")})` : ""}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;

  return (
    <div className="border-b border-amber-500/30 bg-amber-50 dark:bg-amber-950/60">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm sm:px-6">
        <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{what}</span>
        <span className="text-zinc-600 dark:text-zinc-400">The report and its line numbers show the code as it was.</span>
        {phase === "reviewing" && !drift.branch && (
          <button
            type="button"
            disabled={asked}
            onClick={async () => {
              setAsked(true);
              await requestRefresh();
            }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs font-medium hover:bg-amber-500/10 disabled:opacity-60"
          >
            <RefreshCw className="size-3.5" />
            {asked ? "Asked Claude to update the report" : "Ask Claude to update the report"}
          </button>
        )}
      </div>
    </div>
  );
};
