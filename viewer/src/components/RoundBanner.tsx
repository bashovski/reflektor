import { ArrowRight, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bundle } from "../../../skill/schema/types";
import { fetchRound } from "../lib/live";
import { useReview } from "../lib/review";
import { useRounds } from "../lib/rounds";

// When the agent publishes a newer round, the open page offers it instead of reloading by itself.
export const RoundBanner = () => {
  const { round, latestRound, mode } = useReview();
  const { showRound } = useRounds();
  const [next, setNext] = useState<Bundle | null>(null);
  const newer = mode === "server" && latestRound > round;

  useEffect(() => {
    if (!newer) return;
    fetchRound(latestRound)
      .then(setNext)
      .catch(() => setNext(null));
  }, [newer, latestRound]);

  if (!newer) return null;
  const replies = next?.report?.review?.replies ?? [];
  const count = (status: string) => replies.filter((r) => r.status === status).length;
  const parts = [
    count("fixed") && `${count("fixed")} fixed`,
    count("answered") && `${count("answered")} answered`,
    count("wontfix") && `${count("wontfix")} won't fix`,
    count("noted") && `${count("noted")} noted`,
  ].filter(Boolean);

  return (
    <div className="sticky top-14 z-20 border-b border-blue-500/30 bg-blue-50 dark:bg-blue-950">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-4 py-2.5 text-sm sm:px-6">
        <Sparkles className="size-4 text-blue-600 dark:text-blue-400" />
        <span className="font-medium">Round {latestRound} is ready.</span>
        {parts.length > 0 && <span className="text-zinc-600 dark:text-zinc-400">{parts.join(", ")}.</span>}
        <button
          type="button"
          onClick={() => showRound(latestRound)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        >
          Show round {latestRound} <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
};
