// Who is using pr-report, for the review page's top bar: the person's account on the repo's forge when
// its CLI is logged in (gh for GitHub, glab for GitLab), else the git identity set in the repo. The CLIs'
// config files are read for the login only, never for a token, and what is kept on disk
// (~/.pr-report/cache/identity/) is the public profile.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoAvatar } from "../schema/types.js";
import { ownerAvatar } from "./avatar.mjs";

// The reader's account on the forge, as the CLI reports it and as it is cached.
type Account = { source: "gh" | "glab"; login: string; name: string | null; url: string; checkedAt?: string };
// Who is reading, for /api/me. viewer/src/lib/identity.ts has the same shape.
export type Identity = { source: Account["source"] | "git" | "none"; login: string | null; name: string | null; email: string | null; url: string | null; host: string | null; avatar: RepoAvatar };

const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const CLI_TIMEOUT_MS = 10_000;
// A profile from the CLI is reused for a day before asking again. After a failed call (offline, logged
// out, no CLI) the git identity stands for five minutes, so a page does not start a CLI on every load.
const FRESH_MS = 24 * 3_600_000;
const RETRY_MS = 5 * 60_000;

const run = promisify(execFile);
// windowsHide: the daemon has no console on Windows, so each call would flash a window.
const cli = (cmd: string, args: string[], cwd: string | undefined): Promise<string | null> =>
  run(cmd, args, { cwd, timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }).then((x) => x.stdout.trim(), () => null);
const parse = <T,>(text: string): T | null => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// gh keeps the active login per host in hosts.yml, next to the token. Only the login line is read.
function ghHostsFile(): string {
  if (process.env.GH_CONFIG_DIR) return join(process.env.GH_CONFIG_DIR, "hosts.yml");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "GitHub CLI", "hosts.yml");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh", "hosts.yml");
}

export function ghLogin(host: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(ghHostsFile(), "utf8").split("\n");
  } catch {
    return null;
  }
  const start = lines.findIndex((line) => line.trimEnd() === `${host}:`);
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    // The next host starts at the left margin.
    if (line.trim() && !/^\s/.test(line)) break;
    const match = line.match(/^\s+user:\s*(\S+)\s*$/);
    if (match) return match[1];
  }
  return null;
}

// The account on the forge, through its CLI. null when there is no CLI, no login, or no network.
async function forgeAccount(forge: string | null, host: string, cwd: string | undefined): Promise<Account | null> {
  if (forge === "github") {
    const user = parse<{ login?: string; name?: string | null; html_url?: string }>((await cli("gh", ["api", "user", "--hostname", host], cwd)) ?? "");
    if (user?.login) return { source: "gh", login: user.login, name: user.name || null, url: user.html_url || `https://${host}/${user.login}` };
    // Offline or rate limited: the login in gh's own config is still right, so the page is not nameless.
    const login = ghLogin(host);
    return login ? { source: "gh", login, name: null, url: `https://${host}/${login}` } : null;
  }
  if (forge === "gitlab") {
    const user = parse<{ username?: string; name?: string | null; web_url?: string }>((await cli("glab", ["api", "user", "--hostname", host], cwd)) ?? "");
    if (user?.username) return { source: "glab", login: user.username, name: user.name || null, url: user.web_url || `https://${host}/${user.username}` };
  }
  return null;
}

const identityFile = (host: string): string => join(HOME, "cache", "identity", `${host.toLowerCase().replace(/[^a-z0-9.-]+/g, "_")}.json`);
const readCached = (host: string): (Account & { checkedAt: string }) | null => {
  try {
    return JSON.parse(readFileSync(identityFile(host), "utf8"));
  } catch {
    return null;
  }
};

// Forge accounts this process has looked up, by host (a login is per host), and when to look again.
const accounts = new Map<string, { retryAt: number; account: Account | null }>();

async function account(forge: string | null, host: string | null, cwd: string | undefined): Promise<Account | null> {
  if (!forge || !host) return null;
  const known = accounts.get(host);
  if (known && Date.now() < known.retryAt) return known.account;

  const cached = readCached(host);
  if (cached && Date.now() - Date.parse(cached.checkedAt) < FRESH_MS) {
    accounts.set(host, { retryAt: Date.now() + FRESH_MS, account: cached });
    return cached;
  }
  const found = await forgeAccount(forge, host, cwd);
  if (found) {
    found.checkedAt = new Date().toISOString();
    try {
      mkdirSync(join(HOME, "cache", "identity"), { recursive: true });
      writeFileSync(identityFile(host), JSON.stringify(found, null, 2));
    } catch {
      // The cache is a convenience; the answer is still good.
    }
  }
  // Without an answer, a stale profile is better than none while offline, but the CLI is asked again soon.
  accounts.set(host, { retryAt: Date.now() + (found ? FRESH_MS : RETRY_MS), account: found ?? cached });
  return found ?? cached;
}

async function gitIdentity(root: string | null): Promise<{ name: string | null; email: string | null }> {
  if (!root || !existsSync(root)) return { name: null, email: null };
  const [name, email] = await Promise.all([cli("git", ["config", "user.name"], root), cli("git", ["config", "user.email"], root)]);
  return { name: name || null, email: email || null };
}

// host and forge come from the repo's remote (collect.mjs works them out), root is the repo on disk.
export async function whoAmI({ host, forge, root }: { host: string | null; forge: string | null; root: string | null }): Promise<Identity> {
  const cwd = root && existsSync(root) ? root : undefined;
  const [found, git] = await Promise.all([account(forge, host, cwd), gitIdentity(root)]);
  const name = found?.name ?? git.name ?? found?.login ?? null;
  const source: Identity["source"] = found?.source ?? (git.name || git.email ? "git" : "none");
  // A forge account gets its picture the way repo owners do; a git identity gets initials.
  const avatar = await ownerAvatar({ host: found ? host : null, owner: found?.login ?? null, name: name ?? git.email ?? "?" }, { allowDownload: Boolean(found) });
  return { source, login: found?.login ?? null, name, email: git.email, url: found?.url ?? null, host: host ?? null, avatar };
}

// Deletes ~/.pr-report/cache: owner and user avatars and the identity profiles, all fetched again when
// needed. Reviews and saved checks live elsewhere and are not touched. Returns how many files went.
export function purgeCache(): number {
  const dir = join(HOME, "cache");
  let removed = 0;
  const count = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) count(join(folder, entry.name));
      else removed++;
    }
  };
  if (existsSync(dir)) {
    count(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  accounts.clear();
  return removed;
}
