import type { ScreenshotsRun, Shot } from "../../../skill/schema/types";
import { useLive } from "./live";
import { useReport } from "./state";

// The screenshots to show: live from the daemon while they are taken or after, otherwise as they were when the report
// was built (exported pages, older rounds).
export function useScreenshots(): ScreenshotsRun | null {
  const { bundle } = useReport();
  const { live } = useLive();
  const current = live && live.round === bundle.round ? live.screenshots : undefined;
  return current === undefined ? (bundle.screenshots ?? null) : current;
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
