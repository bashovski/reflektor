import { useCallback, useEffect, useState } from "react";
import { pageToken } from "./panel";

// Reflektor, where the reader's organization reads published reports. The daemon holds the login and does the
// publishing (skill/scripts/reflektor.mts); a page only asks it. A report saved as a file has no daemon, so nothing
// here shows there.

// A sign-in waiting for the reader to approve the code in the browser.
export type SignIn = { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string; error: string | null };
// What GET /api/reflektor answers.
// `apiUrl` is the API in use (the login's, or the one a sign-in would use), and `apiUrlFromEnv` says REFLEKTOR_API_URL
// is set for the daemon, which wins over the setting.
export type ReflektorStatus = {
  signedIn: boolean;
  user: { name: string | null; email: string } | null;
  appUrl: string | null;
  apiUrl: string | null;
  defaultApiUrl: string;
  apiUrlFromEnv: boolean;
  autoPublish: boolean;
  signIn: SignIn | null;
};
// What a publish answers. `organizations` comes with organization_required: the ones to choose from.
export type PublishAnswer = { ok: boolean; reason: string | null; message: string; round: number | null; url: string | null; organization: string | null; organizations?: { slug: string; name: string }[]; already?: boolean };

const ask = async <T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> => {
  const res = await fetch(path, {
    method,
    headers: { "x-review-token": pageToken(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "The daemon did not answer.");
  return data;
};

// The account and the sign-in, as the daemon has them. null until it answered, and on a page without a daemon. Asked
// again whenever `shown` turns true and when the window gets the focus back, since a sign-in in the terminal changes it.
export function useReflektor(shown = true) {
  const [status, setStatus] = useState<ReflektorStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!pageToken()) return null;
    const next = await ask<ReflektorStatus>("/api/reflektor").catch(() => null);
    if (next) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    if (!shown || !pageToken()) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [shown, refresh]);

  const signIn = async () => setStatus(await ask<ReflektorStatus>("/api/reflektor/login", "POST"));
  const signOut = async () => setStatus(await ask<ReflektorStatus>("/api/reflektor/logout", "POST"));
  return { status, refresh, signIn, signOut };
}

// Publishes the review behind `api` (`/api/r/<id>`) now, to `organization` when the reader picked one.
export const publishReview = (api: string, organization?: string) => ask<PublishAnswer>(`${api}/reflektor`, "POST", organization ? { organization } : {});

// Reflektor's own site, where Docs, Examples and Pricing live: the one the daemon signs in to, else the public one.
export const DEFAULT_APP_URL = "https://reflektor.dev";

export const PLATFORM_PAGES = [
  { path: "/docs", label: "Docs" },
  { path: "/examples", label: "Examples" },
  { path: "/pricing", label: "Pricing" },
] as const;

export function useAppUrl() {
  const { status } = useReflektor(Boolean(pageToken()));
  return (status?.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");
}
