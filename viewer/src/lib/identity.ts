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

// One lookup per page load; the daemon answers from its own cache after the first time anyway.
let pending: Promise<Identity | null> | null = null;

export function useIdentity(params: { host: string | null; forge: string | null; root: string }): Identity | null {
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    const config = window.__PR_REVIEW__;
    if (!config) return;
    pending ??= fetch(`/api/me?${new URLSearchParams({ host: params.host ?? "", forge: params.forge ?? "", root: params.root })}`, {
      headers: { "x-review-token": config.token },
    })
      .then((res) => (res.ok ? (res.json() as Promise<Identity>) : null))
      .catch(() => null);
    let mounted = true;
    void pending.then((who) => mounted && setIdentity(who));
    return () => {
      mounted = false;
    };
  }, [params.host, params.forge, params.root]);
  return identity;
}
