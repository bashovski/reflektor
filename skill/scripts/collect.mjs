#!/usr/bin/env node
// Collects everything git knows about a branch into one JSON file (diff.json).
// Works with any language or stack: it only talks to git, to `gh` when present, and once per repo
// owner to github.com or gitlab.com for the owner's avatar.
//
// Usage:
//   node collect.mjs [--repo .] [--base <branch>] [--since <sha|last>] [--files a,b,c] [--update]
//                    [--no-uncommitted] [--no-fetch] [--coverage <file>]... [--out diff.json]
//
// --update brings the last report up to date with the code: the whole branch again, report.json's
// line references moved to where those lines are now, and, after a sent review, what changed since
// that round. For the fix loop, and for code that changed after a report was built.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ownerAvatar } from "./avatar.mjs";
import { globToRegExp, parseRemote, reportDir, shellPath } from "./repo.mjs";

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 8000;

const LOCKFILES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json",
  "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock", "composer.lock",
  "Gemfile.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "Package.resolved", "packages.lock.json",
  "gradle.lockfile", "flake.lock", "deno.lock", "conan.lock",
]);
const GENERATED = [
  /\.min\.(js|css)$/, /\.map$/, /\.snap$/, /(^|\/)__snapshots__\//, /(^|\/)__generated__\//,
  /\.pb\.go$/, /_pb2(_grpc)?\.py$/, /\.g\.dart$/, /\.freezed\.dart$/, /\.generated\.\w+$/, /_generated\.\w+$/,
  /(^|\/)(dist|build|vendor)\//,
];

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const args = { repo: ".", coverage: [], uncommitted: true, fetch: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--repo") args.repo = next();
    else if (a === "--base") args.base = next();
    else if (a === "--since") args.since = next();
    else if (a === "--files") args.files = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--coverage") args.coverage.push(next());
    else if (a === "--no-uncommitted") args.uncommitted = false;
    else if (a === "--no-fetch") args.fetch = false;
    else if (a === "--update") args.update = true;
    else if (a === "--out") args.out = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.update && (args.since || args.files)) throw new Error("--update covers the whole branch; it does not go with --since or --files.");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const warnings = [];

// ------------------------------------------------------------------ git helpers

const repoRoot = run("git", ["rev-parse", "--show-toplevel"], resolve(args.repo)).trim();

function run(cmd, argv, cwd = repoRoot, opts = {}) {
  return execFileSync(cmd, argv, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}
const git = (...argv) => run("git", ["-c", "core.quotePath=false", ...argv]);
const tryGit = (...argv) => {
  try {
    return git(...argv);
  } catch {
    return null;
  }
};
const refExists = (ref) => tryGit("rev-parse", "--verify", "--quiet", `${ref}^{commit}`) !== null;
// One git process for many lookups, fed through stdin. Returns raw bytes.
const gitStdin = (input, ...argv) =>
  run("git", ["-c", "core.quotePath=false", ...argv], repoRoot, { input: Buffer.from(input), encoding: "buffer", stdio: ["pipe", "pipe", "pipe"] });

function hasCommand(cmd) {
  try {
    run(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ repo config (.pr-report.json)

function loadConfig() {
  const file = join(repoRoot, ".pr-report.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    warnings.push(`.pr-report.json is not valid JSON, ignored: ${e.message}`);
    return null;
  }
}

const config = loadConfig();
const targetGlobs = Object.entries(config?.targets ?? {}).flatMap(([target, globs]) => globs.map((g) => [target, globToRegExp(g)]));
const generatedGlobs = (config?.generated ?? []).map(globToRegExp);
const targetFor = (path) => targetGlobs.find(([, re]) => re.test(path))?.[0] ?? null;

// ------------------------------------------------------------------ repo identity

const remoteName = (tryGit("remote") ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const remote = remoteName.includes("origin") ? "origin" : remoteName[0];
const remoteUrl = remote ? tryGit("remote", "get-url", remote)?.trim() : null;
const identity = parseRemote(remoteUrl) ?? {
  host: null,
  owner: null,
  name: basename(repoRoot),
};
// An SSH remote can name a Host alias from ~/.ssh/config (git@github-work:acme/app). ssh -G prints
// the real host without connecting. Aliases have no dot; GitHub's and GitLab's SSH-over-443 hosts
// map back to their web hosts.
if (identity.host && !identity.host.includes(".") && remoteUrl && !/^https?:/.test(remoteUrl)) {
  try {
    const real = run("ssh", ["-G", identity.host], repoRoot, { timeout: 3000 }).match(/^hostname (\S+)$/m)?.[1];
    if (real) identity.host = real.toLowerCase();
  } catch {
    // No ssh client: keep the name from the URL.
  }
}
identity.host = { "ssh.github.com": "github.com", "altssh.gitlab.com": "gitlab.com" }[identity.host] ?? identity.host;

// The repo on the web, for the page's owner and pull request links. Self-hosted GitLab and GitHub
// Enterprise keep their URL layout, so the forge comes from the host name.
const forge = /github/.test(identity.host ?? "") ? "github" : /gitlab/.test(identity.host ?? "") ? "gitlab" : /bitbucket/.test(identity.host ?? "") ? "bitbucket" : null;
const web = identity.host && identity.owner ? { url: `https://${identity.host}/${identity.owner}/${identity.name}`, ownerUrl: `https://${identity.host}/${identity.owner}`, forge } : null;

// ------------------------------------------------------------------ base branch

const head = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const headSha = git("rev-parse", "HEAD").trim();

// The branch's pull request, through gh (github.com only), in any state. An open one sets the base
// branch; the page links to it either way.
function findPr() {
  if (head === "HEAD" || identity.host !== "github.com" || !hasCommand("gh")) return null;
  try {
    return JSON.parse(run("gh", ["pr", "view", head, "--json", "number,url,title,baseRefName,state"], repoRoot, { timeout: 15_000 }));
  } catch {
    return null;
  }
}
const pr = findPr();

let base;
let baseSource;
if (args.base) {
  base = args.base;
  baseSource = "argument";
} else if (pr?.state === "OPEN") {
  base = pr.baseRefName;
  baseSource = "open-pr";
} else if (config?.base) {
  base = config.base;
  baseSource = "config";
} else {
  const symbolic = remote ? tryGit("symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`) : null;
  if (symbolic) {
    base = symbolic.trim().replace(`${remote}/`, "");
    baseSource = "default-branch";
  } else {
    base = ["main", "master", "develop", "trunk"].find((b) => refExists(b) || (remote && refExists(`${remote}/${b}`)));
    baseSource = "guess";
  }
}
if (!base) throw new Error("Could not find a base branch. Pass --base <branch>.");

if (args.fetch && remote) {
  try {
    git("fetch", "--quiet", remote, base);
  } catch {
    warnings.push(`Could not fetch ${remote}/${base}. Using the local copy, which may be out of date.`);
  }
}

const baseRef = remote && refExists(`${remote}/${base}`) ? `${remote}/${base}` : base;
if (!refExists(baseRef)) throw new Error(`Base branch "${base}" does not exist locally or on ${remote}.`);
const mergeBase = git("merge-base", "HEAD", baseRef).trim();

// Whether the branch is on the remote, as of the last fetch or push, and how many commits are not.
const remoteBranch = remote && head !== "HEAD" && refExists(`${remote}/${head}`) ? `${remote}/${head}` : null;
const upstream = remoteBranch ? { ref: remoteBranch, ahead: Number(git("rev-list", "--count", `${remoteBranch}..HEAD`).trim()) } : null;

// ------------------------------------------------------------------ scope

const gitDir = resolve(repoRoot, git("rev-parse", "--git-dir").trim());
const out = resolve(args.out ?? join(reportDir(gitDir, head), "diff.json"));
const stateFile = join(dirname(out), "last.json");
const reportFile = join(dirname(out), "report.json");

let from = mergeBase;
let mode = "branch";
if (args.since) {
  let since = args.since;
  if (since === "last") {
    if (!existsSync(stateFile)) throw new Error("No earlier report found for --since last. Run once without it first.");
    const last = JSON.parse(readFileSync(stateFile, "utf8"));
    since = last.snapshot ?? last.headSha;
  }
  from = git("rev-parse", since).trim();
  mode = "since";
}
if (args.files) mode = mode === "since" ? "since+files" : "files";

// ------------------------------------------------------------------ snapshot
// Records exactly what this report shows, uncommitted and untracked files included, as a commit
// under refs/pr-report/last. `--since last` diffs against it, so changes that were uncommitted
// at the last report do not show up again once they are committed. Nothing in the working tree,
// the real index or any branch changes.

function snapshotWorkingTree() {
  if (!args.uncommitted) return headSha;
  const tmpIndex = join(gitDir, "pr-report", "snapshot.index");
  mkdirSync(dirname(tmpIndex), { recursive: true });
  const realIndex = join(gitDir, "index");
  if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "pr-report",
    GIT_AUTHOR_EMAIL: "pr-report@localhost",
    GIT_COMMITTER_NAME: "pr-report",
    GIT_COMMITTER_EMAIL: "pr-report@localhost",
  };
  try {
    run("git", ["add", "-A"], repoRoot, { env });
    const tree = run("git", ["write-tree"], repoRoot, { env }).trim();
    return run("git", ["commit-tree", tree, "-p", headSha, "-m", "pr-report snapshot"], repoRoot, { env }).trim();
  } catch {
    warnings.push("Could not snapshot uncommitted work, so this report covers committed changes only.");
    return headSha;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

const snapshot = snapshotWorkingTree();

// Compare commit to commit. The snapshot holds uncommitted and untracked files, so they are
// compared like any other change, including by `--since last`.
const to = args.uncommitted ? snapshot : "HEAD";

// ------------------------------------------------------------------ changed files

function parseNameStatus(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split("\t");
    const code = status[0];
    if (code === "R" || code === "C") out.push({ status: code === "R" ? "renamed" : "added", oldPath: a, path: b });
    else if (code === "A") out.push({ status: "added", oldPath: null, path: a });
    else if (code === "D") out.push({ status: "deleted", oldPath: a, path: a });
    else out.push({ status: "modified", oldPath: a, path: a });
  }
  return out;
}

function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split("\t");
    let path = rest.join("\t");
    const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (brace) path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/");
    else if (path.includes(" => ")) path = path.split(" => ")[1];
    map.set(path, { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del), binary: add === "-" });
  }
  return map;
}

// Line numbers that changed, from a zero-context diff.
function parseChangedLines(text) {
  const map = new Map();
  let current = null;
  let oldPath = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      current = p === "/dev/null" ? oldPath : p.replace(/^b\//, "");
      if (current && !map.has(current)) map.set(current, { added: [], removed: [] });
      continue;
    }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && current) {
      const [oldStart, oldLen, newStart, newLen] = [Number(h[1]), h[2] === undefined ? 1 : Number(h[2]), Number(h[3]), h[4] === undefined ? 1 : Number(h[4])];
      const entry = map.get(current);
      for (let i = 0; i < oldLen; i++) entry.removed.push(oldStart + i);
      for (let i = 0; i < newLen; i++) entry.added.push(newStart + i);
    }
  }
  return map;
}

const uncommittedSet = new Set();
const untracked = [];
if (args.uncommitted) {
  for (const p of (tryGit("diff", "--name-only", "HEAD", snapshot) ?? "").split("\n")) if (p.trim()) uncommittedSet.add(p.trim());
  for (const p of git("ls-files", "--others", "--exclude-standard").split("\n")) if (p.trim()) untracked.push(p.trim());
}

// Files marked `linguist-generated` in .gitattributes, asked for all paths at once.
function generatedByAttribute(paths) {
  if (!paths.length) return new Set();
  try {
    const out = gitStdin(paths.join("\0") + "\0", "check-attr", "-z", "--stdin", "linguist-generated").toString("utf8").split("\0");
    const set = new Set();
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === "set" || out[i + 2] === "true") set.add(out[i]);
    return set;
  } catch {
    return new Set();
  }
}

const TOO_LARGE = Symbol("too large");

// Reads every "<rev>:<path>" with two git processes instead of one per file: --batch-check for the
// sizes, then --batch for the contents of files small enough to show.
// Each value is the text, TOO_LARGE, or null when git has no such file.
function readBlobs(specs) {
  const result = new Map(specs.map((s) => [s, null]));
  // The batch protocol is line based; the rare path with a newline in it is read on its own.
  for (const spec of specs.filter((s) => s.includes("\n"))) result.set(spec, tryGit("show", spec));
  const batchable = specs.filter((s) => !s.includes("\n"));
  if (!batchable.length) return result;

  const checks = gitStdin(batchable.join("\n") + "\n", "cat-file", "--batch-check").toString("utf8").split("\n");
  const wanted = [];
  batchable.forEach((spec, i) => {
    const [, type, size] = checks[i].split(" ");
    if (type !== "blob") return;
    if (Number(size) > MAX_BYTES) result.set(spec, TOO_LARGE);
    else wanted.push(spec);
  });
  if (!wanted.length) return result;

  // Each answer is "<sha> blob <size>\n", then <size> bytes, then "\n".
  const out = gitStdin(wanted.join("\n") + "\n", "cat-file", "--batch");
  let at = 0;
  for (const spec of wanted) {
    const eol = out.indexOf(10, at);
    const size = Number(out.subarray(at, eol).toString("latin1").split(" ")[2]);
    result.set(spec, out.subarray(eol + 1, eol + 1 + size).toString("utf8"));
    at = eol + 1 + size + 1;
  }
  return result;
}

function looksBinary(text) {
  return typeof text === "string" && text.slice(0, 8000).includes("\u0000");
}
function tooLarge(text) {
  return text === TOO_LARGE || (typeof text === "string" && (text.length > MAX_BYTES || text.split("\n").length > MAX_LINES));
}

// The files that differ between two commits, with both versions and the changed line numbers.
function diffFiles(a, b, wanted = null) {
  let entries = parseNameStatus(git("diff", "--name-status", "-M", a, b));
  if (wanted) entries = entries.filter((e) => wanted.has(e.path) || wanted.has(e.oldPath));
  const numstat = parseNumstat(git("diff", "--numstat", "-M", a, b));
  const changedLines = parseChangedLines(git("diff", "-U0", "--no-color", "-M", a, b));
  const oldSpec = (e) => `${a}:${e.oldPath ?? e.path}`;
  const newSpec = (e) => `${b}:${e.path}`;
  const blobs = readBlobs([...entries.filter((e) => e.status !== "added").map(oldSpec), ...entries.filter((e) => e.status !== "deleted").map(newSpec)]);
  const attributeGenerated = generatedByAttribute(entries.map((e) => e.path));
  const isGenerated = (path) =>
    LOCKFILES.has(basename(path)) || GENERATED.some((re) => re.test(path)) || generatedGlobs.some((re) => re.test(path)) || attributeGenerated.has(path);

  return entries
    .map((e) => {
      const stat = numstat.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
      let oldContent = e.status === "added" ? null : blobs.get(oldSpec(e));
      let newContent = e.status === "deleted" ? null : blobs.get(newSpec(e));
      const binary = stat.binary || looksBinary(oldContent) || looksBinary(newContent);
      const large = tooLarge(oldContent) || tooLarge(newContent);
      if (binary || large) {
        oldContent = null;
        newContent = null;
      }
      return {
        path: e.path,
        oldPath: e.status === "renamed" ? e.oldPath : null,
        status: e.status,
        additions: stat.additions,
        deletions: stat.deletions,
        binary,
        tooLarge: large,
        generated: isGenerated(e.path),
        uncommitted: uncommittedSet.has(e.path),
        untracked: untracked.includes(e.path),
        target: targetFor(e.path),
        oldContent,
        newContent,
        changedLines: changedLines.get(e.path) ?? { added: [], removed: [] },
      };
    })
    .sort((x, y) => x.path.localeCompare(y.path));
}

const files = diffFiles(from, to, args.files ? new Set(args.files) : null);

if (!files.length) {
  console.log(`No changes between ${baseRef} (${from.slice(0, 7)}) and ${args.uncommitted ? "the working tree" : "HEAD"}. Nothing to report.`);
  process.exit(3);
}

// ------------------------------------------------------------------ update
// Every round shows the whole branch, so the reviewer approves what will be merged. sinceRound holds
// what changed since the round the reviewer sent, for the page's "since round N" view. The last
// report.json is carried forward: its line references move to where those lines are now, and the
// ones on changed lines are listed for Claude to check.

const commitExists = (sha) => Boolean(sha) && tryGit("cat-file", "-e", `${sha}^{commit}`) !== null;
const toHead = to === "HEAD" ? headSha : to;

function latestReview() {
  const dir = dirname(out);
  const rounds = existsSync(dir) ? readdirSync(dir).map((f) => Number(f.match(/^review-(\d+)\.json$/)?.[1])).filter(Boolean) : [];
  if (!rounds.length) return null;
  const round = Math.max(...rounds);
  return { round, ...JSON.parse(readFileSync(join(dir, `review-${round}.json`), "utf8")) };
}

// Hunks of a zero-context diff per file: where lines went between two commits.
function parseHunks(text) {
  const map = new Map();
  let oldPath = null;
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) oldPath = line.slice(4) === "/dev/null" ? null : line.slice(4).replace(/^a\//, "");
    else if (line.startsWith("+++ ")) {
      const newPath = line.slice(4) === "/dev/null" ? null : line.slice(4).replace(/^b\//, "");
      current = { newPath, hunks: [] };
      if (oldPath) map.set(oldPath, current);
    } else {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h && current) current.hunks.push({ oldStart: +h[1], oldLen: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLen: h[4] === undefined ? 1 : +h[4] });
    }
  }
  return map;
}

// Where an old line is now. `changed` when the line itself changed; it then points at the new code there.
function moveLine(hunks, line) {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldLen === 0) {
      if (h.oldStart < line) {
        delta += h.newLen;
        continue;
      }
      break;
    }
    if (line < h.oldStart) break;
    if (line < h.oldStart + h.oldLen) return { line: Math.max(1, h.newStart), changed: true };
    delta += h.newLen - h.oldLen;
  }
  return { line: line + delta, changed: false };
}

let sinceRound = null;
let carried = null;
if (args.update) {
  const sent = latestReview();
  const roundFrom = sent && (commitExists(sent.snapshot) ? sent.snapshot : commitExists(sent.headSha) ? sent.headSha : null);
  if (sent && !roundFrom) warnings.push(`The code of round ${sent.round} is no longer in git, so the page cannot show what changed since then.`);
  else if (sent) sinceRound = { round: sent.round, from: roundFrom, files: diffFiles(roundFrom, to) };

  // report.json's references point into the snapshot it was last built against.
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
  const last = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  const refsFrom = report?.refsAt ?? last?.snapshot ?? last?.headSha;
  if (!report) warnings.push(`No report.json at ${reportFile} to carry forward; write a new one.`);
  else if (!commitExists(refsFrom)) warnings.push("The code report.json was written for is no longer in git, so its line references were not moved. Check them.");
  else if (refsFrom === toHead) carried = { moved: 0, check: [], gone: [] };
  else {
    const moves = parseHunks(git("diff", "-U0", "--no-color", "-M", refsFrom, to));
    carried = { moved: 0, check: [], gone: [] };
    // Moves one reference in place. Old-side lines are in the base version, which did not change.
    const carry = (ref, where, path = ref?.path) => {
      if (!ref || ref.side === "old" || !path) return;
      const m = moves.get(path);
      if (!m) return;
      if (!m.newPath) {
        carried.gone.push(`${where}: ${path}`);
        return;
      }
      if (m.newPath !== path && "path" in ref) ref.path = m.newPath;
      if (ref.line == null) return;
      const moved = moveLine(m.hunks, ref.line);
      if (moved.line !== ref.line) carried.moved++;
      if (moved.changed) carried.check.push(`${where}: ${m.newPath}:${moved.line}`);
      ref.line = moved.line;
    };
    for (const [i, b] of (report.beforeMerge ?? []).entries()) carry(b.ref, `beforeMerge[${i}]`);
    for (const [si, sec] of (report.sections ?? []).entries()) {
      const where = `sections[${si}] (${sec.kind})`;
      for (const [hi, h] of (sec.highlights ?? []).entries()) carry(h.ref, `${where}.highlights[${hi}]`);
      for (const f of sec.files ?? []) {
        const original = f.path;
        for (const n of f.lineNotes ?? []) carry(n, `${where} line note`, original);
        const m = moves.get(original);
        if (m?.newPath && m.newPath !== original) f.path = m.newPath;
      }
    }
    for (const [i, item] of (report.plan?.items ?? []).entries()) carry(item.ref, `plan.items[${i}]`);
    for (const [i, t] of (report.schema?.tables ?? []).entries()) carry(t.ref, `schema.tables[${i}] (${t.name})`);
    for (const [fi, flow] of (report.flows ?? []).entries()) for (const [si, st] of (flow.steps ?? []).entries()) carry(st.ref, `flows[${fi}].steps[${si}] (${st.symbol})`);
    for (const [i, c] of (report.contracts ?? []).entries()) if (c.status !== "removed") carry(c.ref, `contracts[${i}] (${c.name})`);
  }
  if (report && carried) {
    report.refsAt = toHead;
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
}


// ------------------------------------------------------------------ safety checks
// Fixed rules on added lines: likely secrets, and database migrations that can break a deploy.
// These are facts for Claude to judge; secret values are never printed in full.

const SECRET_RULES = [
  ["aws-key", "AWS access key", /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/],
  ["private-key", "Private key", /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)/],
  ["github-token", "GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["gitlab-token", "GitLab token", /\b(glpat-[A-Za-z0-9_-]{20,})\b/],
  ["slack-token", "Slack token", /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/],
  ["stripe-key", "Stripe live key", /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/],
  ["google-key", "Google API key", /\b(AIza[0-9A-Za-z_-]{35})\b/],
  ["ai-key", "AI API key", /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,})\b/],
  ["jwt", "JSON Web Token", /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/],
  ["password-in-code", "Password or secret in code", /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s$<>{}]{8,})["']/i],
  ["url-password", "Password in a connection URL", /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+):([^\s:@/]{3,})@/i],
];
// Values that are obviously placeholders, so "postgres://app:app@db" in a dev setup is not flagged.
const PLACEHOLDER = /^(password|passwd|secret|changeme|change-me|example|sample|test|testing|dev|local|postgres|root|admin|user|pass|x+|\*+|\.+)$/i;
const NOT_REAL = /(^|\/)(\.env\.(example|sample|template|dist)|[^/]*\.(example|sample|template)(\.[^/]+)?|[^/]*\.md)$|(^|\/)(tests?|__tests__|spec|fixtures?|testdata)\//i;
const SECRET_FILES = [
  [/(^|\/)\.env(\.(local|prod|production|staging|dev|development))?$/i, "Env file committed", "Env files usually hold real secrets. Keep them out of git and add them to .gitignore."],
  [/\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, "Key file committed", "Private key files must not be in git. Anyone with repo access can use the key."],
];

const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic|flyway|liquibase)(\/|$)|\.sql$|(^|\/)schema\.(rb|sql|prisma)$/i;
const MIGRATION_RULES = [
  ["Drops a table", "high", /\bDROP\s+TABLE\b|\bdrop_table\b|\.dropTable\s*\(|\bDeleteModel\s*\(|Schema::drop/i,
    "Drops a table. Its data is gone, and code that still reads it breaks during the deploy."],
  ["Drops a column", "high", /\bDROP\s+COLUMN\b|\bremove_column\b|\.dropColumn\s*\(|\bRemoveField\s*\(/i,
    "Drops a column. Its data is gone, and the old code that runs during the deploy breaks."],
  ["Empties a table", "high", /\bTRUNCATE\b/i, "Deletes every row in a table."],
  ["NOT NULL column without a default", "high",
    (l) => (/\bADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?\S+\s+\S+.*\bNOT\s+NULL\b/i.test(l) && !/\bDEFAULT\b/i.test(l)) ||
      (/\badd_column\b.*\bnull:\s*false\b/.test(l) && !/\bdefault:/.test(l)),
    "Adds a NOT NULL column without a default. This fails on a table that already has rows."],
  ["Renames a table or column", "medium", /\bRENAME\s+(COLUMN\s+\S+\s+)?TO\b|\brename_(column|table)\b|\.renameColumn\s*\(|\bRename(Field|Model)\s*\(/i,
    "Renames a table or column. Code from before the deploy still uses the old name until it is replaced."],
  ["Changes a column type", "medium", /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b|\bchange_column\b|\bAlterField\s*\(/i,
    "Changes a column type. The database may rewrite and lock the whole table."],
  ["Writes rows without WHERE", "medium", (l) => /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/i.test(l) && !/\bWHERE\b/i.test(l),
    "Changes or deletes rows without a WHERE clause, so it touches every row."],
];
const INDEX_RULE = /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?["`]?([\w.]+)/i;

const mask = (value) => (value.length <= 8 ? "…" : `${value.slice(0, 4)}…(${value.length} characters)`);

const findings = [];
for (const f of files) {
  if (f.status === "added" && !NOT_REAL.test(f.path)) {
    for (const [re, rule, message] of SECRET_FILES) {
      if (re.test(f.path)) findings.push({ kind: "secret", rule, severity: "high", path: f.path, line: null, message });
    }
  }
  if (f.newContent == null || f.generated) continue;
  const lines = f.newContent.split("\n");
  const added = new Set(f.changedLines.added);
  const scanSecrets = !NOT_REAL.test(f.path);
  const isMigration = MIGRATION_PATH.test(f.path);
  const createdTables = new Set([...f.newContent.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)/gi)].map((m) => m[1].toLowerCase()));

  for (const n of added) {
    const text = lines[n - 1] ?? "";
    if (scanSecrets) {
      for (const [id, label, re] of SECRET_RULES) {
        const m = text.match(re);
        if (!m) continue;
        if (id === "url-password" && (PLACEHOLDER.test(m[2]) || m[1] === m[2])) continue;
        if (id === "password-in-code" && PLACEHOLDER.test(m[1])) continue;
        const value = id === "url-password" ? m[2] : m[1];
        const severity = id === "password-in-code" || id === "url-password" ? "medium" : "high";
        findings.push({
          kind: "secret", rule: label, severity, path: f.path, line: n, preview: mask(value),
          message: "Looks like a real secret. Remove it, rotate it, and load it from the environment instead. If it was ever committed, it stays in the git history.",
        });
        break;
      }
    }
    if (!isMigration) continue;
    for (const [rule, severity, test, message] of MIGRATION_RULES) {
      const hit = typeof test === "function" ? test(text) : test.test(text);
      if (hit) findings.push({ kind: "migration", rule, severity, path: f.path, line: n, message });
    }
    const idx = text.match(INDEX_RULE);
    if (idx && !createdTables.has(idx[2].toLowerCase())) {
      findings.push({
        kind: "migration", rule: "Creates an index that locks the table", severity: "low", path: f.path, line: n,
        message: "Creates an index on an existing table without CONCURRENTLY. In Postgres this blocks writes while the index builds.",
      });
    }
  }
}
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));

// ------------------------------------------------------------------ commits

const commits = git("log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", `${from}..HEAD`)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, short, subject, author, date] = line.split("\x1f");
    return { sha, short, subject, author, date };
  });

// ------------------------------------------------------------------ coverage
// Reads common coverage formats and maps them onto added lines.
// Formats: lcov, Go coverprofile, Cobertura XML, JaCoCo XML, Clover XML, coverage.py JSON.

function parseCoverage(file) {
  const text = readFileSync(file, "utf8");
  const result = new Map(); // path -> Map(line -> hits)
  const add = (path, line, hits) => {
    if (!result.has(path)) result.set(path, new Map());
    const m = result.get(path);
    m.set(line, Math.max(m.get(line) ?? 0, hits));
  };

  if (/^(TN:|SF:)/m.test(text) && /end_of_record/.test(text)) {
    let sf = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("SF:")) sf = line.slice(3).trim();
      else if (line.startsWith("DA:") && sf) {
        const [ln, hits] = line.slice(3).split(",");
        add(sf, Number(ln), Number(hits));
      }
    }
    return { format: "lcov", result };
  }
  if (/^mode: (set|count|atomic)/.test(text)) {
    for (const line of text.split("\n").slice(1)) {
      const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/);
      if (!m) continue;
      for (let l = Number(m[2]); l <= Number(m[3]); l++) add(m[1], l, Number(m[4]));
    }
    return { format: "go", result };
  }
  if (text.trimStart().startsWith("{")) {
    const json = JSON.parse(text);
    if (json.files && json.meta) {
      for (const [path, f] of Object.entries(json.files)) {
        for (const l of f.executed_lines ?? []) add(path, l, 1);
        for (const l of f.missing_lines ?? []) add(path, l, 0);
      }
      return { format: "coverage.py", result };
    }
  }
  if (/<report[\s>]/.test(text) && /<sourcefile/.test(text)) {
    for (const pkg of text.matchAll(/<package name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) {
      for (const sf of pkg[2].matchAll(/<sourcefile name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g)) {
        const path = pkg[1] ? `${pkg[1]}/${sf[1]}` : sf[1];
        for (const ln of sf[2].matchAll(/<line nr="(\d+)" mi="(\d+)" ci="(\d+)"/g)) add(path, Number(ln[1]), Number(ln[3]) > 0 ? 1 : 0);
      }
    }
    return { format: "jacoco", result };
  }
  if (/<coverage[\s>]/.test(text) && /<class [^>]*filename=/.test(text)) {
    for (const cls of text.matchAll(/<class [^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
      for (const ln of cls[2].matchAll(/<line [^>]*number="(\d+)"[^>]*hits="(\d+)"/g)) add(cls[1], Number(ln[1]), Number(ln[2]));
    }
    return { format: "cobertura", result };
  }
  if (/<coverage[\s>]/.test(text) && /<file [^>]*(name|path)=/.test(text)) {
    for (const f of text.matchAll(/<file [^>]*?(?:path|name)="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g)) {
      for (const ln of f[2].matchAll(/<line [^>]*num="(\d+)"[^>]*count="(\d+)"/g)) add(f[1], Number(ln[1]), Number(ln[2]));
    }
    return { format: "clover", result };
  }
  throw new Error(`Unknown coverage format: ${file}`);
}

// Coverage tools write paths relative to different roots, so match on the longest shared suffix.
function matchPath(covPath, diffPaths) {
  const norm = covPath.replace(/\\/g, "/").replace(/^\.\//, "");
  let best = null;
  let bestLen = 0;
  for (const p of diffPaths) {
    if (norm === p || norm.endsWith(`/${p}`) || p.endsWith(`/${norm}`)) {
      const len = Math.min(norm.length, p.length);
      if (len > bestLen) {
        best = p;
        bestLen = len;
      }
    }
  }
  return best;
}

let coverage = null;
const coverageFiles = args.coverage.length
  ? args.coverage.map((f) => resolve(f))
  : (config?.coverage?.files ?? []).map((f) => resolve(repoRoot, f)).filter(existsSync);
if (coverageFiles.length) {
  const diffPaths = files.map((f) => f.path);
  const perFile = {};
  const sources = [];
  // A coverage file older than the newest change does not describe this code.
  const newestChange = Math.max(
    commits.length ? Date.parse(commits[0].date) : 0,
    ...files.filter((f) => f.uncommitted && existsSync(join(repoRoot, f.path))).map((f) => statSync(join(repoRoot, f.path)).mtimeMs),
  );
  for (const covFile of coverageFiles) {
    if (!existsSync(covFile)) {
      warnings.push(`Coverage file not found: ${covFile}`);
      continue;
    }
    const { format, result } = parseCoverage(covFile);
    const modified = statSync(covFile).mtimeMs;
    const stale = modified < newestChange;
    const shown = shellPath(relative(repoRoot, covFile).startsWith("..") ? covFile : relative(repoRoot, covFile));
    if (stale) warnings.push(`Coverage file ${shown} is older than the latest change; its numbers may be wrong.`);
    sources.push({ file: shown, format, modified: new Date(modified).toISOString(), stale });
    for (const [covPath, lines] of result) {
      const path = matchPath(covPath, diffPaths);
      if (!path) continue;
      const added = new Set(files.find((f) => f.path === path).changedLines.added);
      const entry = (perFile[path] ??= { covered: [], uncovered: [] });
      for (const [line, hits] of lines) {
        if (!added.has(line)) continue;
        (hits > 0 ? entry.covered : entry.uncovered).push(line);
      }
    }
  }
  let covered = 0;
  let uncovered = 0;
  for (const entry of Object.values(perFile)) {
    entry.covered.sort((a, b) => a - b);
    entry.uncovered.sort((a, b) => a - b);
    covered += entry.covered.length;
    uncovered += entry.uncovered.length;
  }
  coverage = {
    sources,
    files: perFile,
    covered,
    uncovered,
    percent: covered + uncovered ? Math.round((covered / (covered + uncovered)) * 100) : null,
  };
}

// ------------------------------------------------------------------ output

const data = {
  version: 1,
  generatedAt: new Date().toISOString(),
  // --no-fetch stays offline: an avatar downloaded before is still used.
  repo: { ...identity, root: repoRoot, gitDir, web, avatar: await ownerAvatar(identity, { allowDownload: args.fetch }) },
  branch: { head, headSha, snapshot, base, baseRef, baseSource, mergeBase, pr: pr ? { number: pr.number, url: pr.url, title: pr.title, state: pr.state } : null, upstream },
  scope: { mode, from, includesUncommitted: args.uncommitted, files: args.files ?? null },
  ...(sinceRound ? { sinceRound } : {}),
  commits,
  stats: {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    uncommittedFiles: files.filter((f) => f.uncommitted).length,
  },
  files,
  coverage,
  findings,
  config,
  warnings,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 2));

console.log(`Diff file:   ${shellPath(out)}`);
console.log(`Report file: ${shellPath(reportFile)}   (${carried ? "carried forward from the last round; update it" : "write report.json here"})`);
console.log(`${identity.owner ?? ""}${identity.owner ? "/" : ""}${identity.name}  ${head} → ${base} (${baseSource})`);
console.log(`${commits.length} commits, ${files.length} files, +${data.stats.additions} -${data.stats.deletions}, ${data.stats.uncommittedFiles} uncommitted`);
// Groups line numbers into ranges: [3,4,5,9] -> "3-5, 9"
const ranges = (lines) => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out.join(", ");
};
if (coverage) {
  console.log(`Patch coverage: ${coverage.percent ?? "n/a"}% (${coverage.covered}/${coverage.covered + coverage.uncovered} new lines run by tests)`);
  for (const src of coverage.sources) {
    const origin = args.coverage.length ? "" : ", listed in .pr-report.json";
    console.log(`  from ${src.format} file ${src.file}${origin}${src.stale ? "  STALE: older than the latest change" : ""}`);
  }
  for (const [path, f] of Object.entries(coverage.files)) {
    const total = f.covered.length + f.uncovered.length;
    if (total) console.log(`  ${`${f.covered.length}/${total}`.padStart(7)} tested  ${path}${f.uncovered.length ? `  untested lines: ${ranges(f.uncovered)}` : ""}`);
  }
} else {
  console.log("Patch coverage: none (no coverage file given or listed in .pr-report.json)");
}
console.log(config ? "Config: .pr-report.json found" : "Config: no .pr-report.json");
console.log("");
console.log(`Read the changes with: git diff ${from} ${to} -- <path>   (includes uncommitted and untracked files)`);
console.log("Files (status, lines, target from config, flags):");
const code = { added: "A", modified: "M", deleted: "D", renamed: "R" };
for (const f of files) {
  const flags = [f.generated && "generated", f.untracked ? "untracked" : f.uncommitted && "uncommitted", f.binary && "binary", f.tooLarge && "too large"].filter(Boolean);
  const lines = `+${f.additions} -${f.deletions}`;
  console.log(`  ${code[f.status]}  ${lines.padEnd(10)} ${(f.target ?? "-").padEnd(15)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
}
console.log("");
if (sinceRound) {
  console.log(`Since round ${sinceRound.round}, which the reviewer sent: ${sinceRound.files.length} ${sinceRound.files.length === 1 ? "file" : "files"} changed`);
  for (const f of sinceRound.files) console.log(`  ${code[f.status]}  +${f.additions} -${f.deletions}`.padEnd(18) + ` ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`);
  console.log(`Read them with: git diff ${sinceRound.from} ${to} -- <path>`);
  console.log("");
}
if (carried) {
  console.log(`Carried report.json forward: ${carried.moved} line references moved to where their lines are now.`);
  if (carried.check.length) {
    console.log("Check these; the lines they point at changed:");
    for (const c of carried.check.slice(0, 40)) console.log(`  ${c}`);
    if (carried.check.length > 40) console.log(`  ... and ${carried.check.length - 40} more`);
  }
  if (carried.gone.length) console.log(`These point at deleted files; move or remove them:\n${carried.gone.map((g) => `  ${g}`).join("\n")}`);
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const inSections = new Set((report.sections ?? []).flatMap((sec) => (sec.files ?? []).map((f) => f.path)));
  const inBranch = new Set(files.map((f) => f.path));
  const missing = files.filter((f) => !inSections.has(f.path)).map((f) => f.path);
  const left = [...inSections].filter((p) => !inBranch.has(p));
  if (missing.length) console.log(`New in the branch, add them to a section: ${missing.join(", ")}`);
  if (left.length) console.log(`No longer changed by the branch, remove them from their sections: ${left.join(", ")}`);
  console.log("");
}
if (findings.length) {
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  console.log(`Safety checks: ${count("high")} high, ${count("medium")} medium, ${count("low")} low`);
  for (const f of findings) {
    console.log(`  ${f.severity.toUpperCase().padEnd(6)} ${f.kind.padEnd(9)} ${f.path}${f.line ? `:${f.line}` : ""}  ${f.rule}${f.preview ? ` [${f.preview}]` : ""}`);
  }
} else {
  console.log("Safety checks: no likely secrets or risky migrations found");
}
for (const w of warnings) console.log(`warning: ${w}`);
