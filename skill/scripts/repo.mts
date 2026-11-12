// Small helpers shared by the scripts: which repo this is, where its report files go, path globs, and
// running the project's own commands (checks and hooks) with the trust rule they share.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// A path as the agent types it into a command. Claude Code on Windows runs commands in Git Bash,
// where a backslash escapes the next character, so paths are shown with forward slashes there.
export const shellPath = (p) => (process.platform === "win32" ? p.replaceAll("\\", "/") : p);

// The bash that Claude Code on Windows runs commands in: CLAUDE_CODE_GIT_BASH_PATH, or the one that
// comes with Git for Windows, found from git itself. Never the WSL bash in System32, which runs Linux.
export function gitBash() {
  if (process.platform !== "win32") return null;
  const found = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  try {
    // <git>/mingw64/libexec/git-core, so <git> is three folders up.
    const git = join(execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim(), "..", "..", "..");
    found.push(join(git, "bin", "bash.exe"), join(git, "usr", "bin", "bash.exe"));
  } catch {
    // No git on the PATH.
  }
  return found.find((p) => p && existsSync(p)) ?? null;
}

// Moves a finished temp file into place. On Windows a rename onto a file that another process has
// open for a moment (the daemon reading it, a virus scanner) can fail, so it tries again briefly.
export function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// A branch name as one file name: "feat/books" -> "feat-books".
export const branchSlug = (branch) => branch.replace(/[^\w.-]+/g, "-");

// Where a branch's report files go: <git folder>/pr-report/<branch>/, so two branches reviewed in
// one checkout keep their rounds apart. A branch whose last report was written to
// <git folder>/pr-report/ itself, before that layout, keeps using it.
export function reportDir(gitDir, branch) {
  const slug = branchSlug(branch);
  const shared = join(gitDir, "pr-report");
  try {
    const last = JSON.parse(readFileSync(join(shared, "last.json"), "utf8"));
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${escaped}-[0-9a-f]{7}-r\\d+\\.(json|html)$`).test(basename(last.report ?? ""))) return shared;
  } catch {
    // No report from before.
  }
  return join(shared, slug);
}

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

const quietGit = (root, ...argv) => {
  try {
    return execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
};

// The remote a repo's reports follow: origin, else the first one there is.
export function remoteOf(root) {
  const remotes = (quietGit(root, "remote") ?? "").split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

// What pr-report keeps for one repo on this machine: ~/.pr-report/repos/<host>/<owner>/<repo>/, with the
// saved checks and the trusted authors.
export function repoHome(root) {
  const remote = remoteOf(root);
  const home = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
  return join(home, "repos", ...repoKey(parseRemote(remote ? quietGit(root, "remote", "get-url", remote) : null), root));
}

// Authors of the branch's commits other than the user and the authors trusted earlier for this repo
// (trust.json, written by checks.mts --trust). Their code runs when the checks or the hooks run.
// The branch starts at the merge base with the first of refs that exists. null when none does: then
// the branch's commits cannot be told apart from the base's.
export function untrustedAuthors(root, refs) {
  const base = refs
    .filter(Boolean)
    .map((ref) => quietGit(root, "merge-base", "HEAD", ref))
    .find(Boolean);
  if (!base) return null;
  const me = (quietGit(root, "config", "user.email") ?? "").toLowerCase();
  let trusted = [];
  try {
    trusted = JSON.parse(readFileSync(join(repoHome(root), "trust.json"), "utf8")).authors ?? [];
  } catch {
    // Nobody trusted yet.
  }
  const known = new Set(trusted.map((a) => a.toLowerCase()));
  const found = new Map();
  for (const line of (quietGit(root, "log", "--format=%ae%x09%an", `${base}..HEAD`) ?? "").split("\n").filter(Boolean)) {
    const [email, name] = line.split("\t");
    if (email.toLowerCase() !== me && !known.has(email.toLowerCase())) found.set(email.toLowerCase(), `${name} <${email}>`);
  }
  return [...found].map(([email, label]) => ({ email, label }));
}

// Output kept from one command: the last 400 KB, enough for any test runner's summary.
const MAX_OUTPUT = 400 * 1024;
let windowsShell;

// Runs a command line from the project (a check or a hook). An agent on Windows runs its commands in
// Git Bash (Claude Code does), so the project's commands are bash commands there: they run in that bash,
// or in cmd.exe when there is none. Elsewhere they run in sh, in a process group of their own so a
// timeout can stop everything they started. Never throws: { code, timedOut, output, durationMs, error }.
export function runShell(command, { cwd, env = process.env, timeoutMs }) {
  const windows = process.platform === "win32";
  const shell = windows ? (windowsShell ??= gitBash() ?? true) : true;
  const started = Date.now();
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      done({ code: null, timedOut, output, error: null, ...result, durationMs: Date.now() - started });
    };
    const child = spawn(command, { shell, cwd, env, detached: !windows, windowsHide: true });
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    timer = setTimeout(() => {
      timedOut = true;
      // On Windows only taskkill /T reaches the whole tree: the shell, the package manager and the test runner under it.
      if (windows) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.on("close", (code) => finish({ code: timedOut ? null : code }));
    child.on("error", (e) => finish({ error: e.message }));
  });
}
