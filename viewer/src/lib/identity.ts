import { useEffect, useState } from "react";
import type { RepoAvatar } from "../../../skill/schema/types";

// Who is reading the page, as the daemon worked it out: the forge account when its CLI is logged in,
// else the git identity of the repo. See skill/scripts/identity.mjs.
export type Identity = {
  source: "gh" | "glab" | "git" | "none";
  login: string | null;
  name: string | null;
  email: string | null;
  url: string | null;
  host: string | null;
  avatar: RepoAvatar;
};

type Params = { host: string | null; forge: string | null; root: string };

// The last answer is kept in the browser and shown at once, so the avatar is there at the first paint and does not
// pop in a moment later on every page. The inbox keeps and reads the same entry (the reader's menu in
// skill/scripts/daemon.mjs), under the same key, so going from one to the other shows no change either.
const KEPT = "pr-report:me";
const keyOf = (p: Params) => `${p.host ?? ""}|${p.forge ?? ""}|${p.root}`;
const kept = (key: string): Identity | null => {
  try {
    const entry = JSON.parse(localStorage.getItem(KEPT) ?? "null") as { key?: string; who?: Identity } | null;
    return entry?.key === key && entry.who ? entry.who : null;
  } catch {
    return null;
  }
};
const keep = (key: string, who: Identity) => {
  try {
    localStorage.setItem(KEPT, JSON.stringify({ key, who }));
  } catch {
    // Without storage the avatar simply arrives with the answer.
  }
};

// One lookup per page load; the daemon answers from its own cache after the first time anyway.
let pending: Promise<Identity | null> | null = null;

export function useIdentity(params: Params): Identity | null {
  const key = keyOf(params);
  const [identity, setIdentity] = useState<Identity | null>(() => (window.__PR_REVIEW__ ? kept(key) : null));
  useEffect(() => {
    const config = window.__PR_REVIEW__;
    if (!config) return;
    pending ??= fetch(`/api/me?${new URLSearchParams({ host: params.host ?? "", forge: params.forge ?? "", root: params.root })}`, {
      headers: { "x-review-token": config.token },
    })
      .then((res) => (res.ok ? (res.json() as Promise<Identity>) : null))
      .catch(() => null);
    let mounted = true;
    void pending.then((who) => {
      if (!who) return;
      keep(key, who);
      if (mounted) setIdentity(who);
    });
    return () => {
      mounted = false;
    };
  }, [params.host, params.forge, params.root, key]);
  return identity;
}
