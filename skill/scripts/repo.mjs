// Small helpers shared by collect.mjs and checks.mjs: which repo this is, and path globs.

import { createHash } from "node:crypto";
import { basename } from "node:path";

// .gitignore-style globs: "*" stays within a folder, "**" crosses folders, a pattern without "/" matches at any depth.
export function globToRegExp(glob) {
  const pattern = glob.includes("/") ? glob.replace(/^\//, "") : `**/${glob}`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

// "git@github.com:acme/app.git" and "https://gitlab.com/group/sub/app" -> { host, owner, name }.
export function parseRemote(url) {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/, "");
  const m = cleaned.match(/^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+)$/);
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { host: m[1], owner: parts.slice(0, -1).join("/"), name: parts.at(-1) };
}

// Folder segments that name a repo under ~/.pr-report/repos/: host/owner/name from the remote, so
// clones and worktrees share them, or local/<folder>-<hash> for a repo without a remote.
export function repoKey(identity, root) {
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
  if (identity?.host && identity.owner) return [identity.host, ...identity.owner.split("/"), identity.name].map(safe);
  return ["local", safe(`${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`)];
}
