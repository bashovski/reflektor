import type { ChecksRun } from "../../../skill/schema/types";
import { useLive } from "./live";
import { useReport } from "./state";

// The project checks to show: live from the daemon while they run or after they finish, otherwise
// as they were when the report was built (exported pages, older rounds).
export function useChecks(): (ChecksRun & { stale: boolean }) | null {
  const { bundle } = useReport();
  const { live } = useLive();
  const built = bundle.projectChecks;
  const current = live && live.round === bundle.round ? live.checks : null;
  if (!current) return built;
  // The build knows more about staleness (uncommitted files); a newer run only has its commit.
  const sameRun = built?.startedAt != null && built.startedAt === current.startedAt;
  return { ...current, stale: sameRun ? built.stale : current.headSha !== bundle.diff.branch.headSha };
}
