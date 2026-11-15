import { useEffect, useState } from "react";
import { pageToken } from "./panel";

// The settings the agent and the daemon read. The daemon keeps them on disk (skill/scripts/settings.mts), and not in
// the browser like the look of the page, because the scripts that write a report need them.
export type AgentSettings = {
  // Split the reading and writing of a report between subagents that work at the same time.
  subagents: boolean;
  // Take screenshots of the changed UI with Playwright while the report is written.
  screenshots: boolean;
  // Publish a branch's report to Reflektor while its pull request is open, once the reader is signed in there.
  reflektorAutoPublish: boolean;
  // The Reflektor API to sign in with, for a self-hosted Reflektor. Empty means Reflektor's own.
  reflektorApiUrl: string;
};

// The settings as the daemon has them, and a way to change one. `settings` is null until the daemon has answered,
// and stays null where there is no daemon (a report saved as a file), so the caller can leave the control out.
// A change shows at once and is taken back if the daemon does not save it. A dialog passes whether it is open as
// `shown`: the daemon is asked each time it opens, so the value is fresh, and never on a page where it stays closed.
export function useAgentSettings(shown = true) {
  const [settings, setSettings] = useState<AgentSettings | null>(null);

  useEffect(() => {
    const token = pageToken();
    if (!shown || !token) return;
    let mounted = true;
    fetch("/api/settings", { headers: { "x-review-token": token } })
      .then((res) => (res.ok ? (res.json() as Promise<AgentSettings>) : null))
      .catch(() => null)
      .then((found) => mounted && found && setSettings(found));
    return () => {
      mounted = false;
    };
  }, [shown]);

  const change = (patch: Partial<AgentSettings>) => {
    const before = settings;
    if (!before) return;
    setSettings({ ...before, ...patch });
    fetch("/api/settings", { method: "POST", headers: { "x-review-token": pageToken(), "content-type": "application/json" }, body: JSON.stringify(patch) })
      .then((res) => (res.ok ? (res.json() as Promise<AgentSettings>) : before))
      .catch(() => before)
      .then(setSettings);
  };

  // For a value the daemon may refuse, such as a URL: nothing changes on the page until it is saved, and a refusal
  // throws with the daemon's reason for the caller to show.
  const save = async (patch: Partial<AgentSettings>) => {
    const res = await fetch("/api/settings", { method: "POST", headers: { "x-review-token": pageToken(), "content-type": "application/json" }, body: JSON.stringify(patch) });
    const data = (await res.json().catch(() => null)) as (AgentSettings & { error?: string }) | null;
    if (!res.ok || !data) throw new Error(data?.error ?? "The daemon did not save it.");
    setSettings(data);
    return data;
  };

  return { settings, change, save };
}
