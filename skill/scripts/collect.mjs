#!/usr/bin/env node
// Collects everything git knows about a branch into one JSON file (diff.json).
// Works with any language or stack: it only talks to git, and to `gh` when present.
//
// Usage:
//   node collect.mjs [--repo .] [--base <branch>] [--since <sha|last>] [--files a,b,c]
//                    [--no-uncommitted] [--no-fetch] [--coverage <file>]... [--out diff.json]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

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
    else if (a === "--out") args.out = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
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

function hasCommand(cmd) {
  try {
    run(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ repo config (.pr-report.json)

// .gitignore-style globs: "*" stays within a folder, "**" crosses folders, a pattern without "/" matches at any depth.
function globToRegExp(glob) {
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

function parseRemote(url) {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/, "");
  const m = cleaned.match(/^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+)$/);
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { host: m[1], owner: parts.slice(0, -1).join("/"), name: parts.at(-1) };
}

const remoteName = (tryGit("remote") ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const remote = remoteName.includes("origin") ? "origin" : remoteName[0];
const identity = parseRemote(remote ? tryGit("remote", "get-url", remote) : null) ?? {
  host: null,
  owner: null,
  name: basename(repoRoot),
};

// ------------------------------------------------------------------ base branch

const head = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const headSha = git("rev-parse", "HEAD").trim();

let pr = null;
function findOpenPr() {
  if (!hasCommand("gh") || identity.host !== "github.com") return null;
  try {
    const json = run("gh", ["pr", "view", "--json", "number,url,title,baseRefName"]);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

let base;
let baseSource;
if (args.base) {
  base = args.base;
  baseSource = "argument";
} else if ((pr = findOpenPr())) {
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

// ------------------------------------------------------------------ scope

const gitDir = resolve(repoRoot, git("rev-parse", "--git-dir").trim());
const stateFile = join(gitDir, "pr-report", "last.json");

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

const to = args.uncommitted ? null : "HEAD";
const range = to ? [from, to] : [from];

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

const nameStatus = parseNameStatus(git("diff", "--name-status", "-M", ...range));
const numstat = parseNumstat(git("diff", "--numstat", "-M", ...range));
const changedLines = parseChangedLines(git("diff", "-U0", "--no-color", "-M", ...range));

const uncommittedSet = new Set();
const untracked = [];
if (args.uncommitted) {
  for (const p of (tryGit("diff", "--name-only", "HEAD") ?? "").split("\n")) if (p.trim()) uncommittedSet.add(p.trim());
  for (const p of git("ls-files", "--others", "--exclude-standard").split("\n")) {
    if (!p.trim()) continue;
    uncommittedSet.add(p.trim());
    untracked.push(p.trim());
  }
}

let entries = nameStatus;
for (const p of untracked) if (!entries.some((e) => e.path === p)) entries.push({ status: "added", oldPath: null, path: p });
if (args.files) {
  const wanted = new Set(args.files);
  entries = entries.filter((e) => wanted.has(e.path) || wanted.has(e.oldPath));
}

function isGenerated(path) {
  if (LOCKFILES.has(basename(path)) || GENERATED.some((re) => re.test(path)) || generatedGlobs.some((re) => re.test(path))) return true;
  const attr = tryGit("check-attr", "linguist-generated", "--", path) ?? "";
  return /: (set|true)$/.test(attr.trim());
}

function readOld(path) {
  return tryGit("show", `${from}:${path}`);
}
function readNew(path) {
  if (to) return tryGit("show", `${to}:${path}`);
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}
function looksBinary(text) {
  return text !== null && text.slice(0, 8000).includes("\u0000");
}
function tooLarge(text) {
  return text !== null && (text.length > MAX_BYTES || text.split("\n").length > MAX_LINES);
}

const files = entries.map((e) => {
  const stat = numstat.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
  let oldContent = e.status === "added" ? null : readOld(e.oldPath ?? e.path);
  let newContent = e.status === "deleted" ? null : readNew(e.path);
  const binary = stat.binary || looksBinary(oldContent) || looksBinary(newContent);
  const large = tooLarge(oldContent) || tooLarge(newContent);
  const lines = changedLines.get(e.path) ?? { added: [], removed: [] };

  if (untracked.includes(e.path) && newContent !== null) {
    const count = newContent.split("\n").length - (newContent.endsWith("\n") ? 1 : 0);
    stat.additions = count;
    lines.added = Array.from({ length: count }, (_, i) => i + 1);
  }
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
    changedLines: lines,
  };
});

files.sort((a, b) => a.path.localeCompare(b.path));

if (!files.length) {
  console.log(`No changes between ${baseRef} (${from.slice(0, 7)}) and ${args.uncommitted ? "the working tree" : "HEAD"}. Nothing to report.`);
  process.exit(3);
}

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
    warnings.push("Could not snapshot uncommitted work; --since last will compare with the last commit instead.");
    return headSha;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

const snapshot = snapshotWorkingTree();

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
    const shown = relative(repoRoot, covFile).startsWith("..") ? covFile : relative(repoRoot, covFile);
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
  repo: { ...identity, root: repoRoot, gitDir },
  branch: { head, headSha, snapshot, base, baseRef, baseSource, mergeBase, pr: pr ? { number: pr.number, url: pr.url, title: pr.title } : null },
  scope: { mode, from, includesUncommitted: args.uncommitted, files: args.files ?? null },
  commits,
  stats: {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    uncommittedFiles: files.filter((f) => f.uncommitted).length,
  },
  files,
  coverage,
  config,
  warnings,
};

const out = args.out ?? join(gitDir, "pr-report", "diff.json");
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 2));

console.log(`Diff file:   ${resolve(out)}`);
console.log(`Report file: ${join(dirname(resolve(out)), "report.json")}   (write report.json here)`);
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
console.log(`Read the changes with: git diff ${to ? `${from} ${to}` : from} -- <path>   (untracked files: read them directly)`);
console.log("Files (status, lines, target from config, flags):");
const code = { added: "A", modified: "M", deleted: "D", renamed: "R" };
for (const f of files) {
  const flags = [f.generated && "generated", f.untracked ? "untracked" : f.uncommitted && "uncommitted", f.binary && "binary", f.tooLarge && "too large"].filter(Boolean);
  const lines = `+${f.additions} -${f.deletions}`;
  console.log(`  ${code[f.status]}  ${lines.padEnd(10)} ${(f.target ?? "-").padEnd(15)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
}
for (const w of warnings) console.log(`warning: ${w}`);
