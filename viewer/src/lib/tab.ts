import { useEffect, useRef, useState } from "react";
import { setFavicon, type TabIcon } from "./favicon";
import { type LiveState, useLive } from "./live";
import { useMerged } from "./pr";
import { useReview } from "./review";
import { useReport } from "./state";

// The browser tab follows the review: "feature/x · repo", a prefix when the reviewer has
// something to do, and an icon per status. When news arrives while the reviewer is in another
// tab or app, the icon gets a red dot and the title blinks until they come back.
// The daemon and build.mts write the same base title into the page, so it is right before this runs.

const BLINK_MS = 1200;

// What changed that the reviewer should come back for.
function newsBetween(before: LiveState, after: LiveState): string | null {
  if (after.round > before.round) return `Round ${after.round} ready`;
  if (after.phase === "planning" && before.phase !== "planning") return "Plan ready";
  if (after.phase === "done" && before.phase !== "done") return "Review finished";
  if (after.pr?.state === "MERGED" && before.pr?.state !== "MERGED") return "Pull request merged";
  if (after.pr && !before.pr) return `Pull request #${after.pr.number} opened`;
  const answered = (s: LiveState) => s.questions.filter((q) => q.answer).length;
  if (answered(after) > answered(before)) return "Question answered";
  if (before.checks?.status === "running" && after.checks && after.checks.status !== "running") {
    const failed = after.checks.results.filter((r) => r.status !== "passed").length;
    return after.checks.status === "stopped" ? "Checks stopped" : failed ? `${failed} ${failed === 1 ? "check" : "checks"} failed` : "Checks passed";
  }
  return null;
}

function useNewsWhileAway() {
  const { live } = useLive();
  const [news, setNews] = useState({ count: 0, last: "" });
  const previous = useRef(live);

  useEffect(() => {
    const before = previous.current;
    previous.current = live;
    const message = before && live ? newsBetween(before, live) : null;
    if (message && !document.hasFocus()) setNews((n) => ({ count: n.count + 1, last: message }));
  }, [live]);

  useEffect(() => {
    const clear = () => {
      if (document.hasFocus()) setNews({ count: 0, last: "" });
    };
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("focus", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  return news;
}

// The tab title follows the platform's "<page> · Reflektor". `paused` while another page (Settings) owns the title.
export function useTab(paused = false) {
  const { bundle } = useReport();
  const { phase, latestRound, round } = useReview();
  const merged = useMerged();
  const news = useNewsWhileAway();

  const base = `${bundle.report.title || bundle.diff.branch.head}${round > 1 ? ` · Round ${round}` : ""} · Reflektor`;
  const newer = latestRound > round;
  // A merged pull request ends the review whatever round it was in.
  const prefix = newer ? `Round ${latestRound} ready · ` : merged ? "Merged · " : phase === "planning" ? "Plan ready · " : phase === "done" ? "✓ " : "";
  const title = prefix + base;
  const icon: TabIcon = newer ? "review" : merged || phase === "done" ? "done" : phase === "planning" ? "plan" : phase === "sent" || phase === "working" ? "working" : "review";

  useEffect(() => setFavicon(icon, news.count > 0), [icon, news.count]);

  useEffect(() => {
    if (paused) return;
    if (!news.count) {
      document.title = title;
      return;
    }
    const alert = `(${news.count}) ${news.last}`;
    let showAlert = true;
    document.title = alert;
    const id = window.setInterval(() => {
      showAlert = !showAlert;
      document.title = showAlert ? alert : title;
    }, BLINK_MS);
    return () => {
      window.clearInterval(id);
      document.title = title;
    };
  }, [title, news, paused]);
}
