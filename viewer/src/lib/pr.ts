import type { PrState } from "../../../skill/schema/types";
import { useLive } from "./live";
import { useReport } from "./state";

export type PullRequest = { number: number; url: string; title: string | null; state: PrState; base: string | null; mergedAt: string | null };

// The branch's pull request: live from the daemon when it knows one, else as it was when the report
// was built. The daemon learns of a new pull request from the agent and of a merge or a close from
// GitHub, so a page left open follows the pull request without a new report.
export function usePr(): PullRequest | null {
  const { bundle } = useReport();
  const { live } = useLive();
  if (live?.pr) return live.pr;
  const frozen = bundle.diff.branch.pr;
  return frozen ? { number: frozen.number, url: frozen.url, title: frozen.title, state: frozen.state ?? "OPEN", base: bundle.diff.branch.base, mergedAt: null } : null;
}

export const useMerged = () => usePr()?.state === "MERGED";
