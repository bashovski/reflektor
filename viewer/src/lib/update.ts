import { useCallback, useEffect, useState } from "react";
import { useLive } from "./live";
import { pageToken } from "./panel";

// New versions of reflektor (skill/scripts/updates.mts). The daemon looks once an hour and tells open pages on their
// event stream; a page without the stream (the inbox's panel) asks GET /api/update itself.

// What GET /api/update answers, and what the "update" event carries.
export type UpdateInfo = {
  current: string;
  latest: string | null;
  minimum: string | null;
  // "required": the running version is below Reflektor's minimum. "available": a newer release is out.
  status: "none" | "available" | "required";
  notes: string[];
  notesUrl: string | null;
  snoozed: boolean;
  // Whether the modal should open by itself: a required update, or an available one not snoozed.
  prompt: boolean;
  managed: boolean;
  checkedAt: string | null;
  state: "idle" | "checking" | "downloading" | "installing" | "restarting" | "failed";
  error: string | null;
  target: string | null;
  // How many reviews have an agent waiting on them: they stop when reflektor restarts.
  waiting: number;
};

const ask = async (method: "GET" | "POST", path = "/api/update"): Promise<UpdateInfo | null> => {
  try {
    const res = await fetch(path, { method, headers: { "x-review-token": pageToken() } });
    return res.ok ? ((await res.json()) as UpdateInfo) : null;
  } catch {
    return null;
  }
};

export const fetchUpdate = () => ask("GET");
export const startUpdate = () => ask("POST");
export const snoozeUpdate = () => ask("POST", "/api/update/snooze");

// The update as this page knows it: from the event stream on a review page, else asked once and when the window gets
// the focus back.
export function useUpdate(): UpdateInfo | null {
  const { update: streamed, config } = useLive();
  const [asked, setAsked] = useState<UpdateInfo | null>(null);
  const refresh = useCallback(async () => setAsked(await fetchUpdate()), []);
  useEffect(() => {
    if (config || !pageToken()) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [config, refresh]);
  return config ? streamed : asked;
}

// The version the update is to, for the words on the page.
export const nextVersion = (u: UpdateInfo) => u.target ?? u.latest ?? u.minimum ?? "the newest version";
