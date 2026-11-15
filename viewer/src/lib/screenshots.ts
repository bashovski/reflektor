import type { ScreenshotsRun, Shot } from "../../../skill/schema/types";
import { useLive } from "./live";
import { useReport } from "./state";

// The last finished run seen live for each round. When the next round starts, the daemon's live run is that round's,
// and a page still open on the earlier round keeps showing the run it saw finish.
const finished = new Map<number, ScreenshotsRun>();

// The screenshots to show: live from the daemon while they are taken or after, otherwise as they were when the report
// was built (exported pages, older rounds).
export function useScreenshots(): ScreenshotsRun | null {
  const { bundle } = useReport();
  const { live } = useLive();
  const current = live && live.round === bundle.round ? live.screenshots : undefined;
  if (current && (current.status === "done" || current.status === "stopped")) finished.set(bundle.round, current);
  if (current !== undefined) return current;
  return finished.get(bundle.round) ?? bundle.screenshots ?? null;
}

// Where a shot's picture comes from: inside an exported page, else from the daemon, which takes the page token in the
// query since an <img> cannot send a header. The run's time keeps a browser from showing a picture of an earlier run.
export function shotSrc(shot: Shot, run: ScreenshotsRun): string | null {
  if (shot.src) return shot.src;
  const config = window.__PR_REVIEW__;
  if (!config || !shot.file) return null;
  const name = shot.file.split("/").pop()!;
  const query = new URLSearchParams({ token: config.token, v: run.ranAt ?? run.startedAt ?? "" });
  return `${config.api}/shots/${encodeURIComponent(name)}?${query}`;
}
