import { useCallback, useEffect, useState } from "react";
import { pageToken } from "./panel";

// The settings the agent reads. The daemon keeps them on disk (skill/scripts/settings.mjs), and not in the browser
// like the look of the page, because the scripts that write a report need them.
export type AgentSettings = {
  // Split the reading and writing of a report between subagents that work at the same time.
  subagents: boolean;
};

// The settings as the daemon has them, and a way to change one. `settings` is null until the daemon has answered,
// and stays null where there is no daemon (a report saved as a file), so the caller can leave the control out.
// A change shows at once and is taken back if the daemon does not save it.
export function useAgentSettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);

  useEffect(() => {
    const token = pageToken();
    if (!token) return;
    let mounted = true;
    fetch("/api/settings", { headers: { "x-review-token": token } })
      .then((res) => (res.ok ? (res.json() as Promise<AgentSettings>) : null))
      .catch(() => null)
      .then((found) => mounted && found && setSettings(found));
    return () => {
      mounted = false;
    };
  }, []);

  const change = useCallback(
    (patch: Partial<AgentSettings>) => {
      const before = settings;
      if (!before) return;
      setSettings({ ...before, ...patch });
      fetch("/api/settings", { method: "POST", headers: { "x-review-token": pageToken(), "content-type": "application/json" }, body: JSON.stringify(patch) })
        .then((res) => (res.ok ? (res.json() as Promise<AgentSettings>) : Promise.reject(new Error("not saved"))))
        .then(setSettings)
        .catch(() => setSettings(before));
    },
    [settings],
  );

  return { settings, change };
}
