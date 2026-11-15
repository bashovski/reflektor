#!/usr/bin/env node
// End-to-end check: rebuilds the fake books repo, runs collect.mts and build.mts on it with
// samples/report.json, and fails on any warning. Then drives a whole review through a private daemon, and publishes
// reports to a local stand-in for Reflektor.
// Also refreshes samples/bundle.json for `pnpm dev` and the standalone samples/books-report.html.
//
// Usage: pnpm check, or pnpm sample to open the sample report after

import { type ChildProcessByStdio, execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { AgentInfo, Bundle, ChecksRun, DiffData, DiffFile, HookName, InboxData, LiveQuestion, PrState, Report, RepoConfig } from "../skill/schema/types.js";
import { githubPr, startGithubStub } from "./github-stub.mjs";
import { STUB_TOKEN, STUB_USER, type StubAnswer, startReflektorStub } from "./reflektor-stub.mjs";
import { root } from "./paths.mjs";

// What execFileSync throws when the command fails. Every call asks for utf8, so the output is text.
type ExecError = Error & { status: number | null; stdout: string; stderr: string };
// daemon.json in the daemon's home, as far as it is read here.
type DaemonFile = { port: number; pid: number };
// window.__PR_REVIEW__ on a review page (ReviewConfig in viewer/src/lib/live.tsx).
type ReviewConfig = { token: string; api: string; agent?: AgentInfo | null };
// A review's state on the event stream, the fields read here (LiveState in viewer/src/lib/live.tsx).
type LiveState = {
  round: number;
  phase: "reviewing" | "sent" | "planning" | "working" | "done";
  statuses: Record<string, { status: string }>;
  questions: LiveQuestion[];
  checks: ChecksRun | null;
  roundBuiltAt: string | null;
  drift: { files: string[]; fileCount: number; commits: number; branch: string | null } | null;
  pr?: { number: number; state: PrState; base: string | null; mergedAt: string | null } | null;
  agent: AgentInfo | null;
  reflektor?: { published: { round: number; snapshot: string; organization: string; url: string } | null; error: { reason: string; message: string } | null; publishing: boolean };
  listening: boolean;
  undeliveredSince: string | null;
  updatedAt: string;
};

// The suites test the package pnpm build makes (dist/skill/), the files a user gets.
if (!existsSync(join(root, "dist/skill/build.json"))) {
  console.error("error: dist/skill/ is not built. Run pnpm build first.");
  process.exit(1);
}
// The skill as users get it, from its package; only the types come from its source.
const fromPackage = (name: string) => import(pathToFileURL(join(root, "dist/skill/scripts", name)).href);
const { gitBash } = (await fromPackage("repo.mjs")) as typeof import("../skill/scripts/repo.mjs");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-check-"));
const repo = join(tmp, "books");
const html = join(root, "samples", "books-report.html");

// On Windows, the Git Bash that Claude Code uses, not the WSL one that "bash" can find first.
const bash = gitBash() ?? "bash";
const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const fail = (message: string) => {
  console.error(`FAIL ${message}`);
  failed = true;
};

try {
  run(bash, [join(root, "fixtures", "make-books-repo.sh"), repo]);

  // The copy of the skill for an agent other than Claude Code: the folder written out in every command, Claude Code's
  // own front matter left out, and the two fields every agent needs kept.
  const { portableSkillText } = await import("./portable-skill.mjs");
  const portable = portableSkillText(readFileSync(join(root, "skill/SKILL.md"), "utf8"), "C:\\Users\\x\\.agents\\skills\\pr-report");
  const frontMatter = portable.slice(0, portable.indexOf("\n---", 4));
  if (portable.includes("CLAUDE_SKILL_DIR") || /^(allowed-tools|argument-hint):/m.test(frontMatter) || !/^name: pr-report$/m.test(frontMatter) || !/^description: /m.test(frontMatter))
    fail("the skill text for other agents still has Claude Code's placeholder or front matter, or lost its name or description");
  if (!portable.includes('node "C:/Users/x/.agents/skills/pr-report/scripts/collect.mjs" --repo .')) fail("the skill text for other agents does not spell out the skill's folder in its commands");
  // The steps for subagent mode are a file of their own. The placeholder is replaced in SKILL.md only, so it must not be in there.
  if (readFileSync(join(root, "skill/subagents.md"), "utf8").includes("CLAUDE_SKILL_DIR")) fail("skill/subagents.md has Claude Code's placeholder, which nothing replaces in that file");

  // Which agent runs pr-report: said outright, read from the shell's variables, from the skills folder a script was
  // started from, or from the agent's own answer, in that order. Every case names its own variables, so the result does
  // not depend on the shell this check runs in.
  const { detectAgent, decodeAgent, encodeAgent } = (await fromPackage("agent.mjs")) as typeof import("../skill/scripts/agent.mjs");
  const elsewhere = join(root, "dist/skill/scripts/review.mjs");
  type AgentOptions = Parameters<typeof detectAgent>[0];
  const who = (options: AgentOptions) => {
    const a = detectAgent({ env: {}, launchPath: elsewhere, ...options });
    return a ? `${a.id}|${a.name}|${a.product}|${a.resume}|${a.version}|${a.source}` : "nobody";
  };
  const agentCases: [string, AgentOptions, string][] = [
    ["a flag wins over the shell", { id: "codex", env: { CLAUDECODE: "1" } }, "codex|Codex|Codex|null|null|flag"],
    ["PR_REPORT_AGENT", { env: { PR_REPORT_AGENT: "claude-code", AI_AGENT: "codex" } }, "claude-code|Claude|Claude Code|/pr-report resume|null|flag"],
    ["AI_AGENT with a version", { env: { AI_AGENT: "claude-code_2-1-321_agent" } }, "claude-code|Claude|Claude Code|/pr-report resume|2.1.321|env"],
    ["AI_AGENT of an agent with no entry", { env: { AI_AGENT: "some-new-agent_0-9_agent" } }, "some-new-agent|Some New Agent|Some New Agent|null|0.9|env"],
    ["a marker only one agent sets", { env: { CLAUDECODE: "1" } }, "claude-code|Claude|Claude Code|/pr-report resume|null|env"],
    ["the skills folder, Windows", { launchPath: "C:\\Users\\k\\.claude\\skills\\pr-report\\scripts\\review.mjs" }, "claude-code|Claude|Claude Code|/pr-report resume|null|path"],
    ["the skills folder, POSIX", { launchPath: "/home/k/.claude/skills/pr-report/scripts/review.mjs" }, "claude-code|Claude|Claude Code|/pr-report resume|null|path"],
    ["a worktree under .claude is not a skills folder", { launchPath: "/code/app/.claude/worktrees/x/skill/scripts/review.mjs" }, "nobody"],
    ["the agent's own answer, known", { name: "Gemini CLI" }, "gemini-cli|Gemini|Gemini CLI|null|null|self"],
    ["the agent's own answer, unknown and untidy", { name: "  Zed\n Agent " }, "zed-agent|Zed Agent|Zed Agent|null|null|self"],
    ["nothing to go on", {}, "nobody"],
  ];
  for (const [what, options, expected] of agentCases) if (who(options) !== expected) fail(`agent detection, ${what}: got ${who(options)}, expected ${expected}`);
  // What travels in the header is cleaned on arrival: one line, capped, and nothing without a name.
  const arrived = decodeAgent(encodeAgent({ id: "X y", name: `Agent\u0007 ${"z".repeat(80)}`, product: "", resume: null }));
  if (arrived?.name.length !== 40 || /[\u0000-\u001f]/.test(arrived.name) || arrived.product !== arrived.name || decodeAgent(encodeAgent({ id: "x" })) !== null || decodeAgent("%7B") !== null)
    fail(`an agent sent to the daemon is not cleaned: ${JSON.stringify(arrived)}`);

  // The PR type pill is drawn twice, by the viewer (TAGS in meta.ts) and by the inbox (TAGS in daemon.mts), from two lists
  // that cannot share code: the daemon uses Node built-ins only. So the lists are compared here instead.
  // The third-party notices file ships with the skill and must name every package the viewer bundles.
  const notices = readFileSync(join(root, "skill/THIRD-PARTY-NOTICES.md"), "utf8");
  for (const dep of Object.keys((JSON.parse(readFileSync(join(root, "viewer/package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies))
    if (!notices.includes(`## ${dep} `)) fail(`THIRD-PARTY-NOTICES.md does not cover ${dep}; run pnpm run notices`);
  // So must source that was copied into the viewer by hand: each folder in viewer/src/vendor.
  const vendor = join(root, "viewer/src/vendor");
  for (const folder of existsSync(vendor) ? readdirSync(vendor) : [])
    if (!notices.includes(`## ${folder} `)) fail(`THIRD-PARTY-NOTICES.md does not cover viewer/src/vendor/${folder}; add it to COPIED in scripts/build-notices.mts and run pnpm run notices`);

  const lucideName = (icon: string) => icon[0].toLowerCase() + icon.slice(1);
  const viewerTags = Object.fromEntries(
    [...readFileSync(join(root, "viewer/src/lib/meta.ts"), "utf8").matchAll(/^\s+([A-Z]+): \{ color: "(#[0-9a-f]{6})", icon: (\w+) \}/gm)].map(([, tag, color, icon]): [string, string] => [tag, `${color} ${lucideName(icon)}`]),
  );
  const inboxTags = Object.fromEntries([...readFileSync(join(root, "skill/scripts/daemon.mts"), "utf8").matchAll(/^\s+([A-Z]+): \["(#[0-9a-f]{6})", "(\w+)"\]/gm)].map(([, tag, color, icon]): [string, string] => [tag, `${color} ${icon}`]));
  if (Object.keys(viewerTags).length < 7 || Object.keys(inboxTags).length < 7) fail(`could not read both tag lists (viewer ${Object.keys(viewerTags).length}, inbox ${Object.keys(inboxTags).length})`);
  for (const tag of new Set([...Object.keys(viewerTags), ...Object.keys(inboxTags)]))
    if (viewerTags[tag] !== inboxTags[tag]) fail(`the tag lists differ for ${tag}: viewer has ${viewerTags[tag] ?? "nothing"}, the inbox has ${inboxTags[tag] ?? "nothing"}`);

  // A private home, so avatars come only from what this check puts in its cache.
  const home = { PR_REPORT_HOME: join(tmp, "collect-home") };
  const collected = run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"], home);
  if (!collected.includes("Patch coverage: 51%")) fail("collect.mts did not read coverage from .pr-report.json");
  if (!collected.includes("(config)")) fail("collect.mts did not take the base branch from .pr-report.json");
  if (!collected.includes("Safety checks: 1 high, 0 medium, 1 low")) fail("collect.mts safety checks did not find the slug migration problems");
  // The reader's settings: collect says nothing of subagent mode while it is off. The run on the second repo, below, has it on.
  if (collected.includes("Subagent mode")) fail("collect.mts speaks of subagent mode although the setting is off");
  if (/^Hooks? /m.test(collected)) fail("collect.mts printed a hook line for a repo without hooks");
  const books = JSON.parse(readFileSync(join(repo, ".git/pr-report/feat-books/diff.json"), "utf8")) as DiffData;
  if (books.repo.avatar?.initials !== "AL" || books.repo.avatar.image !== null) fail(`acme-labs without a cached avatar should get initials AL: ${JSON.stringify(books.repo.avatar)}`);
  if (books.repo.web?.ownerUrl !== "https://github.com/acme-labs" || books.repo.web.forge !== "github") fail(`collect.mts did not find the repo's web links: ${JSON.stringify(books.repo.web)}`);
  if (books.branch.upstream !== null) fail("feat/books is not on the remote, but collect.mts says it is");
  // Each migration finding names what it hit, for the page to show next to the rule.
  const subjects = (d: DiffData) => (d.findings ?? []).filter((f) => f.kind === "migration").map((f) => `${f.rule}: ${f.subject ?? "-"}`);
  if (subjects(books).join(" | ") !== "NOT NULL column without a default: authors.slug | Creates an index that locks the table: authors")
    fail(`the books migration findings do not name their table and column: ${subjects(books).join(" | ")}`);

  // Edge cases in a second repo. The key-shaped value is built at runtime, so no literal secret is stored here.
  const edgeRepo = join(tmp, "edge");
  mkdirSync(join(edgeRepo, "gen"), { recursive: true });
  writeFileSync(join(edgeRepo, "status.ts"), "export enum Status { Draft, Archived }\nexport const LIMIT = 5;\n");
  run(bash, ["-c", `cd "${edgeRepo}" && git init -q -b main && git add status.ts && git -c user.name=t -c user.email=t@t commit -q -m base && git checkout -qb feat && git remote add origin https://gitlab.com/edge-group/sub/edge.git`]);
  writeFileSync(join(edgeRepo, "status.ts"), "export enum Status { Draft, Published }\nexport const LIMIT = 10;\n");
  // An avatar downloaded earlier: --no-fetch must still use it. A GitLab subgroup is one cache file.
  const cachedAvatar = join(home.PR_REPORT_HOME, "cache/avatars/gitlab.com/edge-group_sub");
  mkdirSync(dirname(cachedAvatar), { recursive: true });
  writeFileSync(cachedAvatar, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
  writeFileSync(join(edgeRepo, "config.js"), `export const key = "${"AKIA" + "Q".repeat(16)}";\n`);
  writeFileSync(join(edgeRepo, ".gitattributes"), "gen/*.js linguist-generated\n");
  writeFileSync(join(edgeRepo, "gen", "api.js"), "export const api = 1;\n");
  writeFileSync(join(edgeRepo, "big.txt"), "x".repeat(600 * 1024));
  writeFileSync(join(edgeRepo, "naïve name.ts"), "export const ok = true;\n");
  // A migration with a list, a statement over several lines, and a rename, so each finding has to name what it hit.
  writeFileSync(
    join(edgeRepo, "cleanup.sql"),
    [
      'DROP TABLE IF EXISTS "old_books", legacy_authors CASCADE;',
      "ALTER TABLE books",
      "  DROP COLUMN isbn10,",
      "  ALTER COLUMN price TYPE numeric;",
      "TRUNCATE sessions;",
      "UPDATE books SET price = 0;",
      "ALTER TABLE authors RENAME COLUMN name TO full_name;",
      "",
    ].join("\n"),
  );
  // Rollback code is not flagged: dbmate's and goose's down sections, and a down file of its own.
  writeFileSync(join(edgeRepo, "dbmate.sql"), "-- migrate:up\nDROP TABLE old_widgets;\n\n-- migrate:down\nDROP TABLE widgets;\n");
  writeFileSync(join(edgeRepo, "goose.sql"), "-- +goose Up\nTRUNCATE logs;\n-- +goose Down\nTRUNCATE audit;\n");
  writeFileSync(join(edgeRepo, "0007_init.down.sql"), "DROP TABLE gizmos;\n");
  // Subagent mode turned on in Settings, for this one run: collect has to say so and name the file with the steps.
  writeFileSync(join(home.PR_REPORT_HOME, "settings.json"), JSON.stringify({ subagents: true }));
  const edgeOut = run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", edgeRepo, "--no-fetch", "--base", "main", "--out", join(tmp, "edge.json")], home);
  rmSync(join(home.PR_REPORT_HOME, "settings.json"));
  const told = edgeOut.match(/^Subagent mode: on .* Read (.+subagents\.md) before/m);
  if (!told || !existsSync(told[1])) fail("collect.mts does not tell the agent that subagent mode is on, or the file it names with the steps is not there");
  if (!edgeOut.includes("AWS access key [AKIA…(20 characters)]")) fail("collect.mts did not flag or mask a fake AWS key");
  const edgeData = JSON.parse(readFileSync(join(tmp, "edge.json"), "utf8")) as DiffData;
  const expectedSubjects = [
    "Drops a table: old_books, legacy_authors",
    "Drops a column: books.isbn10",
    "Empties a table: sessions",
    "Renames a table or column: authors.name → full_name",
    "Changes a column type: books.price",
    "Writes rows without WHERE: books",
  ];
  const edgeSubjects = subjects(edgeData);
  for (const expected of expectedSubjects) if (!edgeSubjects.includes(expected)) fail(`a migration finding does not name what it hit: wanted "${expected}", got ${edgeSubjects.join(" | ")}`);
  if (!edgeOut.includes("Drops a table: old_books, legacy_authors")) fail("collect.mts does not print what a migration finding hit");
  for (const expected of ["Drops a table: old_widgets", "Empties a table: logs"]) if (!edgeSubjects.includes(expected)) fail(`a migration's up section was not checked: wanted "${expected}"`);
  for (const rollback of ["Drops a table: widgets", "Empties a table: audit", "Drops a table: gizmos"]) if (edgeSubjects.includes(rollback)) fail(`rollback code was flagged: "${rollback}"`);
  if (!edgeData.repo.avatar?.image?.startsWith("data:image/png;base64,") || edgeData.repo.avatar.initials !== "EG")
    fail(`a cached avatar was not used: ${JSON.stringify(edgeData.repo.avatar).slice(0, 120)}`);
  const edge = Object.fromEntries(edgeData.files.map((f): [string, DiffFile] => [f.path, f]));
  if (!edge["gen/api.js"]?.generated) fail("collect.mts did not mark a linguist-generated file as generated");
  if (!edge["big.txt"]?.tooLarge || edge["big.txt"].newContent !== null) fail("collect.mts did not leave out a file over the size limit");
  if (edge["naïve name.ts"]?.newContent !== "export const ok = true;\n") fail("collect.mts did not read a file with a space and accent in its name");

  // Contracts: names are looked up in the new file, removed members in the old one; made-up names are dropped.
  writeFileSync(
    join(tmp, "edge-report.json"),
    JSON.stringify({
      version: 1, tag: "FEATURE", title: "Edge", summary: "Edge cases.", targets: ["misc"], reviewMinutes: 1, beforeMerge: [], flows: [], sections: [],
      contracts: [
        { name: "Status", kind: "enum", status: "changed", ref: { path: "status.ts", line: 1 }, members: [{ name: "Published", change: "added" }, { name: "Archived", change: "removed" }] },
        { name: "LIMIT", kind: "constant", status: "changed", ref: { path: "status.ts", line: 2 }, value: "10", was: "5" },
        { name: "api", kind: "constant", status: "new", ref: { path: "gen/api.js", line: 1 } },
        { name: "Nope", kind: "type", status: "new", ref: { path: "status.ts", line: 1 } },
      ],
    }),
  );
  const edgeBuilt = run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(tmp, "edge.json"), "--report", join(tmp, "edge-report.json"), "--out", join(tmp, "edge-out", "edge-r1.json")]);
  const edgeContracts = (JSON.parse(readFileSync(join(tmp, "edge-out", "edge-r1.json"), "utf8")) as Bundle).report.contracts!;
  if (!edgeBuilt.includes('could not find "Nope"')) fail("build.mts did not drop a made-up contract name");
  if (edgeBuilt.includes('member "')) fail(`build.mts rejected a real contract member:\n${edgeBuilt}`);
  if (edgeContracts.map((c) => c.name).join() !== "Status,LIMIT,api") fail(`unexpected contracts after the build: ${edgeContracts.map((c) => c.name).join()}`);
  if (!edgeContracts.find((c) => c.name === "api")?.generated) fail("a contract in a generated file was not marked generated");

  // Base branch without a remote default or a config: the branch this one forked from, unless a
  // common name exists. "old" forked earlier, "feat-copy" holds every commit of feat, so neither counts.
  const basesRepo = join(tmp, "bases");
  mkdirSync(basesRepo, { recursive: true });
  const at = (date: string, cmd: string) => `GIT_AUTHOR_DATE="${date}" GIT_COMMITTER_DATE="${date}" git -c user.name=t -c user.email=t@t ${cmd}`;
  run(bash, ["-c", [
    `cd "${basesRepo}" && git init -q -b release`,
    `echo one > a.txt && git add a.txt && ${at("2024-01-01T10:00:00", "commit -q -m one")}`,
    `git checkout -qb old && echo old > old.txt && git add old.txt && ${at("2024-01-01T11:00:00", "commit -q -m old")}`,
    `git checkout -q release && echo two > a.txt && git add a.txt && ${at("2024-01-02T10:00:00", "commit -q -m two")}`,
    `git checkout -qb feat && echo three > a.txt && git add a.txt && ${at("2024-01-03T10:00:00", "commit -q -m three")}`,
    `git checkout -qb feat-copy && echo four > b.txt && git add b.txt && ${at("2024-01-04T10:00:00", "commit -q -m four")}`,
    `git checkout -q feat`,
  ].join(" && ")]);
  const collectBases = () => run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", basesRepo, "--no-fetch", "--out", join(tmp, "bases.json")], home);
  if (!collectBases().includes("feat → release (guess)")) fail("collect.mts did not pick the branch feat forked from as the base");
  run(bash, ["-c", `cd "${basesRepo}" && git branch main release`]);
  if (!collectBases().includes("feat → main (guess)")) fail("collect.mts did not prefer a common branch name over the fork point");

  // Saved checks: worked out once per repo and reused, skipped when nothing they cover changed, out
  // of date when the file they came from changes or a command is missing.
  const checks = (...a: string[]) => run("node", [join(root, "dist/skill/scripts/checks.mjs"), "--repo", edgeRepo, ...a], home);
  const savedRun = join(tmp, "saved-checks.json");
  if (!checks("--plan").includes("No checks for this repo yet")) fail("checks.mts --plan did not ask for checks in a repo without any");
  writeFileSync(join(edgeRepo, "package.json"), '{"scripts":{"lint":"echo ok"}}\n');
  checks("--save", "--source", "from package.json", "--from", "package.json", "--run", "lint=echo lint ok", "--run", "api=echo api", "--when", "api=api/**");
  if (!existsSync(join(home.PR_REPORT_HOME, "repos/gitlab.com/edge-group/sub/edge/checks.json"))) fail("saved checks are not stored under the repo's remote");
  const plan = checks("--plan");
  if (!plan.includes("saved for this repo") || !plan.includes("skipped, nothing it covers changed: api")) fail(`checks.mts --plan did not use the saved checks:\n${plan}`);
  const ranSaved = checks("--out", savedRun);
  if (!ranSaved.includes("Project checks: 1 passed") || !ranSaved.includes("Skipping api")) fail(`the saved checks did not run as planned:\n${ranSaved}`);
  writeFileSync(join(edgeRepo, "package.json"), '{"scripts":{"lint":"eslint ."}}\n');
  if (!checks("--plan").includes("Out of date: package.json changed")) fail("a changed source file did not mark the saved checks out of date");
  checks("--save", "--from", "package.json", "--run", "lint=definitely-not-a-tool-zz");
  checks("--out", savedRun);
  if (!checks("--plan").includes("could not run")) fail("a missing command did not mark the saved checks out of date");
  checks("--share");
  if (!checks("--plan").includes("Checks come from: .pr-report.json")) fail("--share did not make .pr-report.json the source");
  checks("--forget");

  // A commit by someone else: the checks would run their code, so they wait for the user's yes.
  writeFileSync(join(edgeRepo, "theirs.txt"), "from a teammate\n");
  run(bash, ["-c", `cd "${edgeRepo}" && git add theirs.txt && git -c user.name=Pat -c user.email=pat@other.test commit -q -m theirs`]);
  if (!checks("--plan").includes("Ask the user before starting any checks: this branch has commits by Pat <pat@other.test>")) fail("--plan did not ask first about another author's commits");
  try {
    checks("--run", "x=echo ran", "--out", savedRun);
    fail("checks ran another author's code without --trust");
  } catch (error) {
    const e = error as ExecError;
    if (e.status !== 4 || !e.stdout.includes("Not started")) fail(`checks without --trust did not refuse clearly: ${e.stdout}`);
  }
  if (!checks("--run", "x=echo ran", "--out", savedRun, "--trust").includes("Project checks: 1 passed")) fail("--trust did not start the checks");
  if (checks("--plan").includes("Ask the user")) fail("an author trusted with --trust was asked about again");
  checks("--forget");
  if (!checks("--plan").includes("Ask the user")) fail("--forget did not remove the trusted authors");

  const checked = run("node", [
    join(root, "dist/skill/scripts/checks.mjs"), "--repo", repo,
    "--run", "whitespace=git diff --check HEAD",
    "--run", `typecheck=node -e "console.error('apps/api/src/books/book.service.ts(1,18): error TS7016: Could not find a declaration file for module isbn3.'); process.exit(2)"`,
    "--run", `tests=node -e "console.log('3 passed')"`,
  ]);
  if (!checked.includes("Project checks: 2 passed, 1 failed")) fail("checks.mts did not report 2 passed and 1 failed");

  const built = run("node", [
    join(root, "dist/skill/scripts/build.mjs"),
    "--diff", join(repo, ".git/pr-report/feat-books/diff.json"),
    "--report", join(root, "samples/report.json"),
    "--out", join(root, "samples/bundle.json"),
    "--html", html,
  ]);
  for (const line of built.split("\n").filter((l) => l.startsWith("warning:"))) fail(line);

  // A draft: the facts before the agent's report, every file listed, nothing that needs the report.
  run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--draft", "--out", join(tmp, "draft.json")]);
  const draft = JSON.parse(readFileSync(join(tmp, "draft.json"), "utf8")) as Bundle;
  const listed = draft.report.sections.flatMap((s) => s.files).length;
  if (!draft.draft || draft.prDescription !== null || listed !== draft.diff.files.length) fail(`a draft build is not a draft of every file: ${JSON.stringify({ draft: draft.draft, listed })}`);

  const bundle = JSON.parse(readFileSync(join(root, "samples/bundle.json"), "utf8")) as Bundle;
  const missingIcons = bundle.diff.files.filter((f) => !bundle.fileIcons?.byPath[f.path]);
  if (missingIcons.length) fail(`no file icon for ${missingIcons.length} files (run pnpm build)`);

  const page = readFileSync(html, "utf8");
  if (page.includes("__PR_REPORT_DATA__")) fail("report data was not injected into the viewer");
  // samples/ can hold review files from local runs, which makes this a later round.
  if (!/<title>Save and list books in the library \(new books table, POST and GET \/books\)( · Round \d+)? · Reflektor<\/title>/.test(page)) fail("the standalone page does not carry the report title");
  if (statSync(html).size < 1_000_000) fail("the standalone page is too small; build.mts probably used the unbuilt viewer");

  // Checks started in the background: build does not wait and records them as running; --wait returns their results.
  const bgChecks = join(tmp, "bg-checks.json");
  spawn("node", [join(root, "dist/skill/scripts/checks.mjs"), "--repo", repo, "--out", bgChecks, "--run", "slow=sleep 2"], { stdio: "ignore" });
  const started = () => {
    try {
      return readFileSync(bgChecks, "utf8").includes('"running"');
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && !started(); i++) await sleep(50);
  run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--report", join(root, "samples/report.json"), "--checks", bgChecks, "--out", join(tmp, "bg.json")]);
  const bgRun = (JSON.parse(readFileSync(join(tmp, "bg.json"), "utf8")) as Bundle).projectChecks;
  if (bgRun?.status !== "running" || bgRun.pending.join() !== "slow" || bgRun.file !== bgChecks) fail(`build.mts did not record the running checks: ${JSON.stringify(bgRun)}`);
  const waited = run("node", [join(root, "dist/skill/scripts/checks.mjs"), "--repo", repo, "--out", bgChecks, "--wait"]);
  if (!waited.includes("Project checks: 1 passed")) fail(`checks.mts --wait did not print the finished results:\n${waited}`);

  await daemonFlow();
  updateFlow();
  await concurrentStart();
  await hooksFlow();
  await screenshotsFlow();
  await reflektorFlow();
} catch (error) {
  const e = error as ExecError;
  fail(e.stderr?.toString() || e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ app size
// The page's own scripts and styles load once and stay cached. Languages, themes and fonts load
// separately when needed, so this budget catches a build that bundles them into the entry again.
async function checkAppAssets(base: string, page: string) {
  const ENTRY_BUDGET = 1_200_000;
  const urls = [...page.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  if (!urls.length) return fail("the review page links no app scripts");
  let bytes = 0;
  for (const url of urls) {
    const res = await fetch(`${base}${url}`);
    if (!res.ok) fail(`${url}: HTTP ${res.status}`);
    if (!res.headers.get("cache-control")?.includes("immutable")) fail(`${url} is not cached for good`);
    bytes += (await res.arrayBuffer()).byteLength;
  }
  if (bytes > ENTRY_BUDGET) fail(`the app's entry files are ${Math.round(bytes / 1000)} KB, over the ${ENTRY_BUDGET / 1000} KB budget`);
  // %2f keeps the dots in one path segment, so they reach the daemon instead of being resolved by fetch.
  if ((await fetch(`${base}/app/assets/..%2f..%2f..%2fpackage.json`)).ok) fail("the asset route serves files outside the app folder");
}

// ------------------------------------------------------------------ daemon flow
// A whole review against a private daemon (own home folder and port), driven like an agent and a page.
// GitHub is a local stub: the fake repo's remote is on github.com, so the daemon would otherwise ask
// the real API about it.

async function daemonFlow() {
  const github = await startGithubStub();
  // GH_CONFIG_DIR points at nothing, so gh has no login and the identity lookup falls back to the repo's git config.
  const env = {
    PR_REPORT_HOME: join(tmp, "home"),
    PR_REPORT_PORT: String(4400 + Math.floor(Math.random() * 500)),
    PR_REPORT_DRIFT_SECONDS: "1",
    PR_REPORT_GITHUB_API: github.url,
    PR_REPORT_GITHUB_TOKEN: "stub-token",
    PR_REPORT_PR_POLL_SECONDS: "1",
    GH_CONFIG_DIR: join(tmp, "gh-config"),
    PR_REPORT_AGENT: "claude-code",
  };
  const reviewDir = join(tmp, "review");
  const review = (...args: string[]) => run("node", [join(root, "dist/skill/scripts/review.mjs"), ...args], env);
  // For a command the daemon answers only after asking the GitHub stub, which lives in this process:
  // a blocking call would keep the stub from answering.
  const reviewAsync = (...args: string[]) =>
    new Promise<string>((resolveOut, reject) =>
      execFile("node", [join(root, "dist/skill/scripts/review.mjs"), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }, (e, stdout) => (e ? reject(e) : resolveOut(stdout))),
    );
  const build = (out: string) =>
    run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--report", join(root, "samples/report.json"), "--out", out]);
  try {
    build(join(reviewDir, "round1.json"));
    const opened = review("open", "--report", join(reviewDir, "round1.json"));
    const id = opened.match(/Review id: (\S+)/)?.[1];
    if (!id) return fail(`review.mts open printed no id:\n${opened}`);

    const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8")) as DaemonFile;
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(`${base}/r/${id}`)).text();
    const config = JSON.parse(page.match(/window.__PR_REVIEW__=(\{.*?\})<\/script>/)![1]) as ReviewConfig;
    if (!page.includes("<title>Save and list books in the library (new books table, POST and GET /books) · Reflektor</title>")) fail("the review page does not carry the report title");
    const settings = await (await fetch(`${base}/settings`)).text();
    if (!settings.includes("<title>Settings · Reflektor</title>") || !settings.includes("window.__PR_SETTINGS__=")) fail("/settings is not the settings page");
    if (page.length > 20_000) fail(`the review page is ${page.length} bytes; it should load the app and its data, not carry them`);
    await checkAppAssets(base, page);
    // A failing command prints its reason and exits 1. Before, the error threw out of main() after a fetch, which aborted Node
    // on Windows and printed a stack trace everywhere else.
    try {
      review("open", "--report", join(reviewDir, "missing.json"));
      fail("review.mts open with a missing report did not fail");
    } catch (error) {
      const e = error as ExecError;
      const err = String(e.stderr ?? "");
      if (e.status !== 1 || !err.includes("report file not found") || err.includes("Assertion failed") || err.includes("    at ")) fail(`a failing review.mts command did not end cleanly (exit ${e.status}):\n${err}`);
    }
    const post = (path: string, body: unknown) =>
      fetch(`${base}${config.api}/${path}`, { method: "POST", headers: { "x-review-token": config.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const state = async (): Promise<LiveState> => {
      const res = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      return JSON.parse(new TextDecoder().decode(value).match(/data: (.*)/)![1]);
    };
    // The start of the stream as text, for the events around the states.
    const streamStart = async () => {
      const res = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body!.getReader();
      let text = "";
      for (let i = 0; i < 3 && !text.includes("event: daemon"); i++) text += new TextDecoder().decode((await reader.read()).value);
      reader.cancel();
      return text;
    };

    // Who is reading: the page token is required, and without a gh login the answer is the repo's git identity.
    const meUrl = `${base}/api/me?${new URLSearchParams({ host: "github.com", forge: "github", root: repo })}`;
    if ((await fetch(meUrl)).status !== 401) fail("the identity endpoint answers without the page token");
    const me = (await (await fetch(meUrl, { headers: { "x-review-token": config.token } })).json()) as { source: string; name: string | null; avatar?: { initials: string } };
    if (me.source !== "git" || me.name !== "Sample Dev" || me.avatar?.initials !== "SD") fail(`the identity did not fall back to the repo's git config: ${JSON.stringify(me)}`);
    // The stream introduces the daemon (version, uptime) after the review states, so a first-chunk reader still gets a state first.
    const hello = await streamStart();
    const daemonAt = hello.indexOf("event: daemon");
    if (daemonAt < 0 || daemonAt < hello.indexOf("event: state") || !hello.includes('"startedAt"')) fail("the event stream does not introduce the daemon after the review states");
    // Purging the cache from the page removes what is under cache/ and nothing else.
    mkdirSync(join(env.PR_REPORT_HOME, "cache", "avatars"), { recursive: true });
    writeFileSync(join(env.PR_REPORT_HOME, "cache", "avatars", "stale"), "x");
    const purged = (await (await fetch(`${base}/api/cache/purge`, { method: "POST", headers: { "x-review-token": config.token } })).json()) as { removed: number };
    if (!(purged.removed >= 1) || existsSync(join(env.PR_REPORT_HOME, "cache")) || !existsSync(join(env.PR_REPORT_HOME, "daemon.json"))) fail("purging the cache did not remove exactly the cache folder");
    // The settings the agent reads: behind the page token, off until changed, and saved to the file the scripts read.
    const settingsUrl = `${base}/api/settings`;
    const asPage = { "x-review-token": config.token, "content-type": "application/json" };
    if ((await fetch(settingsUrl)).status !== 401) fail("the settings endpoint answers without the page token");
    const settingsBefore = (await (await fetch(settingsUrl, { headers: asPage })).json()) as Record<string, unknown>;
    const settingsAfter = (await (await fetch(settingsUrl, { method: "POST", headers: asPage, body: JSON.stringify({ subagents: true, other: "x" }) })).json()) as Record<string, unknown>;
    const settingsOnDisk = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "settings.json"), "utf8")) as Record<string, unknown>;
    if (settingsBefore.subagents !== false || settingsAfter.subagents !== true || settingsOnDisk.subagents !== true || "other" in settingsOnDisk)
      fail(`the settings were not saved as sent: ${JSON.stringify({ settingsBefore, settingsAfter, settingsOnDisk })}`);
    if ((await fetch(settingsUrl, { method: "POST", headers: asPage, body: "{" })).status !== 400) fail("the settings endpoint takes a body that is not JSON");
    // The Reflektor API URL from Settings: refused with a reason when it cannot carry a token, saved as a base URL,
    // shown as the address a sign-in would use, and saved empty when reset.
    const postSetting = (body: unknown) => fetch(settingsUrl, { method: "POST", headers: asPage, body: JSON.stringify(body) });
    const refusedUrl = await postSetting({ reflektorApiUrl: "http://reflektor.example.test" });
    if (refusedUrl.status !== 400 || !((await refusedUrl.json()) as { error?: string }).error?.includes("https")) fail("a plain http Reflektor API URL was saved from the page, or refused without a reason");
    const savedUrl = (await (await postSetting({ reflektorApiUrl: " https://reflektor.corp.example.test/api/ " })).json()) as Record<string, unknown>;
    if (savedUrl.reflektorApiUrl !== "https://reflektor.corp.example.test/api") fail(`the Reflektor API URL was not saved as a base URL: ${JSON.stringify(savedUrl)}`);
    const urlStatus = (await (await fetch(`${base}/api/reflektor`, { headers: asPage })).json()) as { apiUrl: string | null; defaultApiUrl: string; apiUrlFromEnv: boolean; signedIn: boolean };
    if (urlStatus.defaultApiUrl !== "https://api.reflektor.dev" || (!urlStatus.apiUrlFromEnv && !urlStatus.signedIn && urlStatus.apiUrl !== "https://reflektor.corp.example.test/api"))
      fail(`the Reflektor status does not show the API a sign-in would use: ${JSON.stringify(urlStatus)}`);
    if (((await (await postSetting({ reflektorApiUrl: "" })).json()) as Record<string, unknown>).reflektorApiUrl !== "") fail("resetting the Reflektor API URL did not save it empty");

    // A value of the wrong type in the file counts as not set.
    writeFileSync(join(env.PR_REPORT_HOME, "settings.json"), JSON.stringify({ subagents: "yes" }));
    if (((await (await fetch(settingsUrl, { headers: asPage })).json()) as Record<string, unknown>).subagents !== false) fail("a setting of the wrong type in settings.json is taken for on");

    // The page is told which agent it talks to: in its config, and live from whoever called last.
    if (config.agent?.name !== "Claude" || (await state()).agent?.product !== "Claude Code") fail(`the page does not know the agent that opened the review: ${JSON.stringify(config.agent)}`);
    review("resume", "--id", id, "--agent", "codex");
    if ((await state()).agent?.name !== "Codex") fail("a call from another agent did not change the agent the page shows");
    // A call that names nobody, such as one typed in a plain terminal, leaves the agent as it was.
    run("node", [join(root, "dist/skill/scripts/review.mjs"), "resume", "--id", id], { ...env, PR_REPORT_AGENT: "", AI_AGENT: "", CLAUDECODE: "" });
    if ((await state()).agent?.name !== "Codex") fail("a call that names no agent cleared the one the page shows");
    review("resume", "--id", id);
    if ((await state()).agent?.name !== "Claude") fail("the agent did not change back with the next call");

    // The inbox reloads on state events; the first one on connect must match what it shows, or it reloads forever.
    const inbox = await (await fetch(`${base}/`)).text();
    const { shown } = JSON.parse(inbox.match(/<script id="inbox-data" type="application\/json">(.*?)<\/script>/)?.[1] ?? '{"shown":{}}') as InboxData;
    if (shown[id] !== (await state()).updatedAt) fail("the inbox would reload on the stream's first state event (reload loop)");
    if ((await state()).listening) fail("a review with no waiter counts as listened to");
    if (!/<span class="av" style="background:#[0-9a-f]{6}">AL<\/span>/.test(inbox)) fail("the inbox does not show the owner's initials");
    if (!inbox.includes("<title>(1) All reviews · Reflektor</title>")) fail("the inbox title does not count the review waiting on you");
    if (!inbox.includes('data-owner="acme-labs"')) fail("the inbox rows do not carry the owner they are grouped by");
    if (!/<span class="tag" style="background:#[0-9a-f]{6}"><svg /.test(inbox)) fail("the inbox tag has no color or icon");
    if (!inbox.includes('name="q"') || !(await (await fetch(`${base}/fuse.mjs`)).text()).includes("Fuse.js")) fail("the inbox search or its Fuse.js file is missing");

    const round1 = (await (await fetch(`${base}${config.api}/bundle?round=1`, { headers: { "x-review-token": config.token } })).json()) as Bundle;
    if (!round1?.report?.title) fail("the daemon did not return round 1's report data as an object");
    await post("presence", { tab: "t1" });
    // The agent rebuilds round 1 (for example after the checks end) and publishes it again.
    build(join(reviewDir, "round1.json"));
    const again = review("open", "--report", join(reviewDir, "round1.json"));
    if (!again.includes("Open in 1 tab")) fail("an open tab was not counted");
    if (!again.includes("already published")) fail("publishing round 1 again did not say it was already published");
    const rebuiltAt = (JSON.parse(readFileSync(join(reviewDir, "round1.json"), "utf8")) as Bundle).builtAt;
    if ((await state()).roundBuiltAt !== rebuiltAt) fail("open pages are not told that round 1 was published again");

    // Code edited after the build: the page is told, and the reviewer can ask the agent for an update.
    const edited = join(repo, "apps/web/src/api/books.ts");
    const original = readFileSync(edited, "utf8");
    writeFileSync(edited, `${original}// edited after the report\n`);
    await post("presence", { tab: "t1" });
    const driftIs = async (test: (drift: LiveState["drift"]) => boolean) => {
      for (let i = 0; i < 30; i++) {
        if (test((await state()).drift)) return true;
        await sleep(200);
      }
      return false;
    };
    if (!(await driftIs((d) => d?.fileCount === 1 && d.files[0] === "apps/web/src/api/books.ts"))) fail("an edit after the build did not reach the page as drift");
    await post("refresh", {});
    if (!review("wait", "--id", id).includes("asked for an updated report")) fail("wait did not report the request for an updated report");
    writeFileSync(edited, original);
    if (!(await driftIs((d) => d === null))) fail("undoing the edit did not clear the drift");

    // The pull request, followed on GitHub (the stub) while the review is on screen: conditional
    // requests, so an unchanged answer is a 304 that costs nothing against the rate limit.
    await post("presence", { tab: "t1" });
    const polls = () => github.requests.filter((q) => q.path === "/repos/acme-labs/library/pulls");
    const pollsUntil = async (test: () => boolean, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        if (test()) return true;
        await sleep(200);
      }
      return false;
    };
    const prIs = async (test: (pr: LiveState["pr"]) => boolean) => {
      for (let i = 0; i < 40; i++) {
        if (test((await state()).pr)) return true;
        await sleep(200);
      }
      return false;
    };
    if (!(await pollsUntil(() => polls().some((q) => q.status === 304)))) fail("the daemon did not poll GitHub for the pull request with an ETag (no 304 answer)");
    const firstPoll = polls()[0];
    if (firstPoll.headers.authorization !== "Bearer stub-token" || firstPoll.headers.accept !== "application/vnd.github+json" || !firstPoll.headers["x-github-api-version"])
      fail(`the pull request poll lacks GitHub's headers: ${JSON.stringify(firstPoll.headers)}`);
    if (firstPoll.query.head !== "acme-labs:feat/books" || firstPoll.query.state !== "all" || firstPoll.query.per_page !== "1") fail(`the pull request poll asks for the wrong thing: ${JSON.stringify(firstPoll.query)}`);
    if ((await state()).pr !== null) fail("a branch without a pull request shows one");
    github.set([githubPr(7, "open")]);
    if (!(await prIs((p) => p?.number === 7 && p.state === "OPEN" && p.base === "main" && p.mergedAt === null))) fail("a pull request opened on GitHub did not reach the page state");
    const openInbox = await (await fetch(`${base}/`)).text();
    if (!/<span class="pr" data-state="OPEN"[^>]*>.*?#7<\/span>/.test(openInbox)) fail("the inbox row has no chip for the open pull request");
    // Rate limited: GitHub names a reset time, and the daemon asks nothing until then.
    github.failNext(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 5) });
    if (!(await pollsUntil(() => polls().at(-1)?.status === 403))) fail("the rate limit answer was never served");
    const limitedAt = polls().length;
    await sleep(1500);
    if (polls().length !== limitedAt) fail("the daemon kept polling GitHub after a 403 with a reset time");
    if (!(await pollsUntil(() => polls().length > limitedAt, 30))) fail("the daemon did not poll again once the rate limit reset");
    // The agent opened a pull request: review.mts pr shows it at once, from the URL gh printed.
    github.know(githubPr(8, "open"));
    github.set([githubPr(8, "open"), githubPr(7, "closed")]);
    const told = await reviewAsync("pr", "--id", id, "--url", "https://github.com/acme-labs/library/pull/8");
    if (!told.includes("pull request #8 (open)")) fail(`review.mts pr did not confirm the pull request:\n${told}`);
    if ((await state()).pr?.number !== 8) fail("review.mts pr did not put the pull request into the page state");
    if (!github.requests.some((q) => q.path === "/repos/acme-labs/library/pulls/8")) fail("the daemon did not read the pull request the agent named");
    // Merged on GitHub: the page and the inbox say so, and the daemon stops asking.
    github.set([githubPr(8, "closed", "2026-11-09T12:00:00Z")]);
    if (!(await prIs((p) => p?.state === "MERGED" && p.mergedAt === "2026-11-09T12:00:00Z"))) fail("a merge on GitHub did not reach the page state");
    const mergedInbox = await (await fetch(`${base}/`)).text();
    if (!mergedInbox.includes('data-phase="merged"') || !mergedInbox.includes(">Merged</span>") || !mergedInbox.includes('data-state="MERGED"')) fail("the inbox does not show the merged review as merged");
    if (!mergedInbox.includes("<title>All reviews · Reflektor</title>")) fail("a merged review still counts as waiting on you in the inbox title");
    const mergedAt = polls().length;
    await sleep(1500);
    if (polls().length !== mergedAt) fail("the daemon kept polling GitHub after the pull request was merged");
    if ((JSON.parse(readFileSync(join(reviewDir, "review-state.json"), "utf8")) as Pick<LiveState, "pr">).pr?.state !== "MERGED") fail("the pull request is not saved with the review's state");

    // Project checks stream into the page as they run, finish or crash.
    const until = async (test: (checks: LiveState["checks"]) => boolean) => {
      for (let i = 0; i < 40; i++) {
        const s = await state();
        if (test(s.checks)) return s.checks;
        await sleep(200);
      }
      return null;
    };
    const checksScript = join(root, "dist/skill/scripts/checks.mjs");
    if ((await state()).checks?.results.length !== 3) fail("the page state does not carry the project checks");
    spawn("node", [checksScript, "--repo", repo, "--run", "quick=sleep 1"], { stdio: "ignore" });
    if (!(await until((c) => c?.status === "running" && c.pending.join() === "quick"))) fail("a running check did not reach the page state");
    if (!(await until((c) => c?.status === "done" && c.results[0]?.status === "passed"))) fail("a finished check did not reach the page state");
    spawn("node", [checksScript, "--repo", repo, "--run", "hang=sleep 3"], { stdio: "ignore" });
    await until((c) => c?.status === "running");
    process.kill((JSON.parse(readFileSync(join(repo, ".git/pr-report/feat-books/checks.json"), "utf8")) as { pid: number }).pid, "SIGKILL");
    if (!(await until((c) => c?.status === "stopped" && c.pending.join() === "hang"))) fail("a crashed check run was not shown as stopped");

    await post("questions", { id: "q_1", target: { type: "report" }, text: "Why two migrations?" });
    if (!(await state()).undeliveredSince) fail("a question nobody picked up is not shown as waiting");
    if (!review("wait", "--id", id).includes("Live question q_1")) fail("wait did not return the live question");
    review("answer", "--id", id, "--question", "q_1", "--text", "One per change.");
    if (!(await state()).questions[0]?.answer) fail("the answer did not reach the page state");
    // --text-file with no path says so, instead of failing inside Node with a TypeError.
    try {
      review("answer", "--id", id, "--question", "q_1", "--text-file");
      fail("answer --text-file with no path did not fail");
    } catch (error) {
      const e = error as ExecError;
      if (e.status !== 1 || !e.stderr.includes("answer needs a file path after --text-file")) fail(`answer --text-file with no path did not say what is missing:\n${e.stderr}`);
    }

    const comment = { id: "c_1", target: { type: "report" }, text: "Rename slug to handle", createdAt: new Date().toISOString() };
    await post("submit", { comments: [comment] });
    if (!review("wait", "--id", id).includes("was sent with 1 comments")) fail("wait did not report the sent review");
    // A session that got the review and ended before posting a plan: a new one picks it up.
    if (!review("resume", "--id", id).includes("was sent with 1 comments")) fail("resume did not hand over a sent review that has no plan yet");
    if (!review("resume", "--repo", repo).includes("No review of feat/books is open")) fail("resume found a review outside this repo's git folder");

    writeFileSync(join(tmp, "plan.json"), JSON.stringify({ steps: [{ comments: ["c_1"], where: "0043_add_author_slug.sql", kind: "fix", action: "Rename the column" }] }));
    review("plan", "--id", id, "--file", join(tmp, "plan.json"));
    if ((await state()).phase !== "planning") fail("posting a plan did not move the review to planning");
    if (!review("resume", "--id", id).includes("waits on the reviewer's decision")) fail("resume handed over a sent review that already has a plan");
    await post("plan-decision", { decision: "approve", kinds: {} });
    if (!review("wait", "--id", id).includes("approved the plan")) fail("wait did not report the approved plan");
    if (!review("resume", "--id", id).includes("approved the plan")) fail("resume did not hand over an approved plan with no progress");

    review("status", "--id", id, "--comment", "c_1", "--status", "fixed", "--text", "Renamed");
    const afterFix = await state();
    if (afterFix.statuses.c_1?.status !== "fixed") fail("the status did not reach the page state");
    if (afterFix.phase !== "working") fail("a fixed comment ended the round before the next round was published");
    if (!review("resume", "--id", id).includes("Every comment in round 1 has a status")) fail("resume did not say the fix loop only needs the next round");

    build(join(reviewDir, "round2.json"));
    if (!review("open", "--report", join(reviewDir, "round2.json")).includes("round 2")) fail("publishing the next build did not start round 2");
    const round2 = await state();
    if (round2.round !== 2 || round2.phase !== "reviewing") fail(`round 2 is not open for review: ${JSON.stringify({ round: round2.round, phase: round2.phase })}`);

    // Only an accepted risk: no code changes, so the last status ends the review without a new round.
    await post("submit", { comments: [{ id: "c_2", kind: "accepted", target: { type: "report" }, text: "", createdAt: new Date().toISOString() }] });
    review("wait", "--id", id);
    if (!review("status", "--id", id, "--comment", "c_2", "--status", "noted", "--text", "Accepted").includes("round 2 is finished")) fail("status did not say the round is finished");
    if ((await state()).phase !== "done") fail("a round with every comment handled and no code change did not finish");
    if (!review("wait", "--id", id).includes("Round 2 of")) fail("wait did not report the finished round");
    // An agent may publish the same round again, for example after losing the daemon. That must not reopen it.
    review("open", "--report", join(reviewDir, "round2.json"));
    const republished = await state();
    if (republished.phase !== "done" || republished.statuses.c_2?.status !== "noted") fail("publishing a finished round again reset it");

    // A waiter keeps waiting while the daemon restarts, as it does when the skill is updated.
    const waiter = spawn("node", [join(root, "dist/skill/scripts/review.mjs"), "wait", "--id", id], { env: { ...process.env, ...env } });
    let waited = "";
    waiter.stdout.on("data", (d) => (waited += d));
    const waiterExit = new Promise((resolveExit) => waiter.on("exit", resolveExit));
    await sleep(500);
    if (!(await state()).listening) fail("a running waiter does not count as listening");
    const daemonPid = () => (JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8")) as DaemonFile).pid;
    const oldPid = daemonPid();
    const goodbye = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`);
    const goodbyeReader = goodbye.body!.getReader();
    review("stop");
    // The daemon tells open pages it is going away, so they can show "restarting" rather than "unavailable".
    let heard = "";
    for (let i = 0; i < 5 && !heard.includes("event: shutdown"); i++) {
      const chunk: { done: boolean; value?: Uint8Array } = await Promise.race([goodbyeReader.read(), sleep(1000).then(() => ({ done: true }))]).catch(() => ({ done: true }));
      if (chunk.done) break;
      heard += new TextDecoder().decode(chunk.value);
    }
    if (!heard.includes("event: shutdown")) fail("open pages are not told that the daemon is shutting down");
    // The waiter starts a new daemon; wait for it, not for the old one in its last moments.
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const restarted = (() => {
        try {
          return daemonPid() !== oldPid;
        } catch {
          return false;
        }
      })();
      if (restarted && (await fetch(`${base}/`).then((r) => r.ok, () => false))) break;
    }
    await post("questions", { id: "q_2", target: { type: "report" }, text: "Still there?" });
    await Promise.race([waiterExit, sleep(15_000)]);
    waiter.kill();
    if (!waited.includes("Live question q_2")) fail(`a waiter did not survive a daemon restart:\n${waited}`);
    if ((await state()).pr?.state !== "MERGED") fail("the new daemon did not load the pull request from the saved state");

    build(join(reviewDir, "round3.json"));
    review("open", "--report", join(reviewDir, "round3.json"));
    await post("submit", { comments: [] });
    if (!review("wait", "--id", id).includes("The review is done")) fail("an empty review did not end the review");

    // Archive, then delete: the review's folder and its round refs go; the code does not.
    if ((await post("delete", {})).status !== 409) fail("a review that is not archived could be deleted");
    await post("archive", {});
    const archivedInbox = await (await fetch(`${base}/`)).text();
    if (!archivedInbox.includes("Archived (1)") || !archivedInbox.includes("<title>All reviews · Reflektor</title>")) fail("an archived review did not move to the archived list");
    if (!run("git", ["-C", repo, "for-each-ref", "refs/pr-report/rounds/feat-books/"]).trim()) fail("build did not keep a ref per round");
    await post("delete", {});
    if (existsSync(reviewDir)) fail("deleting an archived review left its folder");
    if (run("git", ["-C", repo, "for-each-ref", "refs/pr-report/rounds/feat-books/"]).trim()) fail("deleting a review left its round refs");
    if (review("list").includes(id)) fail("a deleted review is still listed");
    console.log(
      "daemon flow: question, drift, pull request polled with ETags, rate limit, told by the agent, merged, live checks, sent review, resume, plan, status, round 2 finished without code changes, publishing again, waiting through a restart, empty round 3, archive and delete all worked",
    );
  } finally {
    try {
      review("stop");
    } catch {
      // Already stopped.
    }
    github.close();
  }
}

// ------------------------------------------------------------------ next round
// After a sent review, collect --update shows the whole branch again, marks what changed since
// the sent round, and moves report.json's line references to where their lines are now.

function updateFlow() {
  const dir = join(tmp, "rounds");
  mkdirSync(dir, { recursive: true });
  const collect = (...a: string[]) => run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch", "--out", join(dir, "diff.json"), ...a]);
  const build = (out: string) => run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(dir, "diff.json"), "--report", join(dir, "report.json"), "--out", join(dir, out)]);
  const readReport = () => JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
  const service = (r: Report) => r.sections.find((s) => s.kind === "backend")!;

  collect();
  writeFileSync(join(dir, "report.json"), readFileSync(join(root, "samples/report.json")));
  build("r1.json");
  const round1 = JSON.parse(readFileSync(join(dir, "r1.json"), "utf8")) as Bundle;
  writeFileSync(join(dir, "review-1.json"), JSON.stringify({ version: 1, round: 1, branch: "feat/books", headSha: round1.diff.branch.headSha, snapshot: round1.diff.branch.snapshot, comments: [], report: join(dir, "r1.json") }));
  const description = readFileSync(join(dir, "pr-description.md"), "utf8");

  // The fix: two lines on top of book.service.ts, and a change to its line 19.
  const file = join(repo, "apps/api/src/books/book.service.ts");
  const lines = readFileSync(file, "utf8").split("\n");
  lines[18] += " // fixed";
  writeFileSync(file, ["// one", "// two", ...lines].join("\n"));

  const collected = collect("--update");
  if (!collected.includes("Since round 1, which the reviewer sent: 1 file changed")) fail(`collect --update did not list the change since round 1:\n${collected}`);
  if (!collected.includes("apps/api/src/books/book.service.ts:21")) fail("collect --update did not ask to check a reference on a changed line");
  const carried = readReport();
  const notes = service(carried).files.find((f) => f.path.endsWith("book.service.ts"))!.lineNotes!.map((n) => n.line);
  if (notes.join() !== "8,21") fail(`line notes were not moved with their lines: ${notes.join()}`);
  if (!carried.refsAt) fail("the carried report does not record which code its references point into");

  if (!collect("--update").includes("0 line references moved")) fail("collecting the next round twice moved the references twice");
  if (service(readReport()).files.find((f) => f.path.endsWith("book.service.ts"))!.lineNotes![0].line !== 8) fail("a second collect changed the moved references");

  writeFileSync(join(dir, "report.json"), JSON.stringify({ ...readReport(), review: { round: 1, replies: [] } }));
  build("r2.json");
  const round2 = JSON.parse(readFileSync(join(dir, "r2.json"), "utf8")) as Bundle;
  if (round2.previousReview?.round !== 1 || "report" in round2.previousReview) fail("round 2 does not carry round 1's review, or carries the local path of its report");
  if (round2.round !== 2 || round2.diff.files.length !== round1.diff.files.length) fail("round 2 does not show the whole branch");
  if (round2.diff.sinceRound?.round !== 1 || round2.diff.sinceRound.files.map((f) => f.path).join() !== "apps/api/src/books/book.service.ts") fail("round 2 does not carry the change since round 1");
  if (!round2.prDescription || readFileSync(join(dir, "pr-description.md"), "utf8") === description) fail("a whole-branch round did not rewrite the PR description");

  // A report about part of the branch leaves the PR description alone.
  const whole = readFileSync(join(dir, "pr-description.md"), "utf8");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n// three\n`);
  collect("--since", "last");
  const partial = build("r3.json");
  if ((JSON.parse(readFileSync(join(dir, "r3.json"), "utf8")) as Bundle).prDescription !== null) fail("a --since report carried a PR description");
  if (readFileSync(join(dir, "pr-description.md"), "utf8") !== whole || !partial.includes("PR description not updated")) fail("a --since report overwrote the PR description");
  // Another branch in the same checkout gets its own report folder, so their rounds stay apart.
  run("git", ["-C", repo, "checkout", "-q", "-b", "feat/other"]);
  const other = run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"]);
  // collect prints the path with forward slashes on every OS (shellPath), so compare with those.
  if (!other.includes(".git/pr-report/feat-other/diff.json")) fail(`a second branch in the same checkout did not get its own report folder:\n${other.split("\n")[0]}`);
  console.log("next round: whole branch with the change since round 1, references moved once, PR description only from whole-branch builds");
}

// Several sessions can start the daemon at the same moment, as when the skill is updated while
// waiters run. Exactly one daemon must come up, none may crash, and an empty lock file left by a
// crash long ago must not block it.
async function concurrentStart() {
  const home = join(tmp, "concurrent-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "daemon.lock"), "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(home, "daemon.lock"), old, old);
  const env = { ...process.env, PR_REPORT_HOME: home, PR_REPORT_PORT: String(5000 + Math.floor(Math.random() * 300)) };
  const daemons = Array.from({ length: 6 }, () => {
    // `output` collects what the daemon prints, on the child itself.
    const child = spawn("node", [join(root, "dist/skill/scripts/daemon.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessByStdio<null, Readable, Readable> & { output: string };
    child.output = "";
    child.stdout.on("data", (d) => (child.output += d));
    child.stderr.on("data", (d) => (child.output += d));
    return child;
  });
  for (let i = 0; i < 60 && daemons.filter((d) => d.exitCode === null).length > 1; i++) await sleep(100);
  await sleep(500);
  const running = daemons.filter((d) => d.exitCode === null);
  const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as DaemonFile;
  if (running.length !== 1 || running[0].pid !== info.pid) fail(`${running.length} daemons kept running after 6 started at once:\n${daemons.map((d) => d.output).join("")}`);
  const crashed = daemons.find((d) => /Error|Assertion/.test(d.output));
  if (crashed) fail(`a daemon crashed when 6 started at once:\n${crashed.output}`);
  for (const d of running) d.kill();
  await sleep(200);
  console.log("concurrent start: one daemon out of 6 started at once, past an old empty lock");
}

// ------------------------------------------------------------------ hooks
// The project's own commands at fixed points of a report (hooks.mts), on a fresh books repo with a
// private daemon. Each hook runs a script that writes a line to a log, so the check can count when
// each one ran and what it was handed.

async function hooksFlow() {
  const github = await startGithubStub();
  const hooksRepo = join(tmp, "hooks-books");
  run(bash, [join(root, "fixtures", "make-books-repo.sh"), hooksRepo]);
  const data = join(hooksRepo, ".git/pr-report/feat-books");
  const log = join(tmp, "hooks.log");
  const logger = join(tmp, "log-hook.mjs");
  writeFileSync(
    logger,
    [
      'import { appendFileSync } from "node:fs";',
      "const e = process.env;",
      'appendFileSync(e.HOOK_LOG, `${[e.PR_REPORT_HOOK, e.PR_REPORT_BRANCH, e.PR_REPORT_BASE, e.PR_REPORT_ROUND ?? "-", e.PR_REPORT_REPORT?.endsWith("report.json") ? "report" : "-", e.PR_REPORT_URL ? "url" : "-"].join(" ")}\\n`);',
      "console.log(`${e.PR_REPORT_HOOK} ran`);",
      "if (e.HOOK_FAIL === e.PR_REPORT_HOOK) process.exit(1);",
    ].join("\n"),
  );
  const logHook = `node "${logger.replaceAll("\\", "/")}"`;
  const setHooks = (hooks: RepoConfig["hooks"]) => {
    const file = join(hooksRepo, ".pr-report.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as RepoConfig), hooks }, null, 2));
  };
  const ran = (hook: HookName) => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((line) => line.startsWith(`${hook} `));
  const env = {
    PR_REPORT_HOME: join(tmp, "hooks-home"),
    PR_REPORT_PORT: String(5400 + Math.floor(Math.random() * 300)),
    PR_REPORT_GITHUB_API: github.url,
    PR_REPORT_GITHUB_TOKEN: "stub-token",
    GH_CONFIG_DIR: join(tmp, "gh-config"),
    PR_REPORT_AGENT: "claude-code",
    HOOK_LOG: log,
  };
  const collect = (extra: NodeJS.ProcessEnv, ...a: string[]) => run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", hooksRepo, "--no-fetch", ...a], { ...env, ...extra });
  const review = (extra: NodeJS.ProcessEnv, ...a: string[]) => run("node", [join(root, "dist/skill/scripts/review.mjs"), ...a], { ...env, ...extra });
  const build = (...a: string[]) => run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(data, "diff.json"), ...a]).match(/Wrote (\S+)/)![1];

  try {
    // preRun: its output goes to the agent, it knows the branch and the base, and collect goes on.
    setHooks({ preRun: ['echo "Ticket ABC-1: let readers save books"', logHook], postRun: logHook, onApproved: logHook });
    const collected = collect({});
    if (!collected.includes("  Ticket ABC-1: let readers save books") || !collected.includes("Diff file")) fail(`preRun's output is not shown, or collect did not go on:\n${collected}`);
    if (ran("preRun").join() !== "preRun feat/books main - - -") fail(`preRun was not handed the branch and base only: ${ran("preRun").join(" | ")}`);

    // A failing preRun stops the report and says why; so does one that runs past its time limit.
    try {
      collect({ HOOK_FAIL: "preRun" });
      fail("a failing preRun hook did not stop collect.mjs");
    } catch (error) {
      const e = error as ExecError;
      if (e.status !== 1 || !e.stdout.includes("preRun ran") || !e.stderr.includes("the preRun hook in .pr-report.json failed")) fail(`a failing preRun did not stop collect clearly:\n${e.stdout}${e.stderr}`);
    }
    setHooks({ preRun: "sleep 20" });
    const started = Date.now();
    try {
      collect({ PR_REPORT_HOOK_SECONDS: "1" });
      fail("a preRun hook past its time limit did not stop collect.mjs");
    } catch (error) {
      const e = error as ExecError;
      if (!e.stdout.includes("Hook preRun timed out after 1s") || Date.now() - started > 10_000) fail(`a slow preRun was not stopped at its time limit:\n${e.stdout}`);
    }
    setHooks({ preRun: logHook, postRun: logHook, onApproved: logHook });

    // postRun: once a round, at the first build that is not a draft. A failure is only a warning.
    writeFileSync(join(data, "report.json"), readFileSync(join(root, "samples/report.json")));
    review({}, "open", "--report", build("--draft"));
    if (ran("postRun").length) fail("postRun ran for a draft");
    const opened = review({ HOOK_FAIL: "postRun" }, "open", "--report", build("--report", join(data, "report.json")));
    const id = opened.match(/Review id: (\S+)/)?.[1];
    // Without a review id the rest of the hooks check cannot run: stop here, as daemonFlow does.
    if (!id) return fail(`review.mjs open printed no review id, so a failing postRun stopped the publish:\n${opened}`);
    if (!opened.includes("warning: the postRun hook in .pr-report.json failed")) fail(`a failing postRun gave no warning:\n${opened}`);
    if (ran("postRun").join() !== "postRun feat/books main 1 report url") fail(`postRun was not handed the round's files: ${ran("postRun").join(" | ")}`);
    review({}, "open", "--report", build("--report", join(data, "report.json")));
    if (ran("postRun").length !== 1) fail("postRun ran again when the same round was published again");

    // onApproved: the reviewer sends the round with no comments. It runs once, in the waiter, and a later resume does not run it again.
    const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8")) as DaemonFile;
    const page = await (await fetch(`http://127.0.0.1:${port}/r/${id}`)).text();
    const config = JSON.parse(page.match(/window.__PR_REVIEW__=(\{.*?\})<\/script>/)![1]) as ReviewConfig;
    const approve = () =>
      fetch(`http://127.0.0.1:${port}${config.api}/submit`, {
        method: "POST",
        headers: { "x-review-token": config.token, "content-type": "application/json" },
        body: JSON.stringify({ comments: [] }),
      });
    await approve();
    const waited = review({}, "wait", "--id", id);
    if (!waited.includes("Hook onApproved:") || !waited.includes("The project's onApproved hook ran")) fail(`the waiter did not run onApproved when the review was done:\n${waited}`);
    review({}, "resume", "--id", id);
    if (ran("onApproved").join() !== "onApproved feat/books main 1 report url") fail(`onApproved did not run exactly once with the round's files: ${ran("onApproved").join(" | ")}`);

    // The next round: postRun again, and with no waiter running, resume picks up the approval. Asked twice, it runs onApproved once.
    review({}, "open", "--report", build("--report", join(data, "report.json")));
    if (ran("postRun").at(-1) !== "postRun feat/books main 2 report url") fail(`postRun did not run for round 2: ${ran("postRun").join(" | ")}`);
    await approve();
    const resumed = review({}, "resume", "--id", id);
    review({}, "resume", "--id", id);
    if (!resumed.includes("Hook onApproved:") || ran("onApproved").length !== 2) fail(`resume did not run onApproved exactly once for round 2 (${ran("onApproved").length} runs in all):\n${resumed}`);

    // The checks' trust rule: no hooks while the branch has a commit by someone not trusted, and none without a base.
    writeFileSync(join(hooksRepo, "theirs.txt"), "from a teammate\n");
    run(bash, ["-c", `cd "${hooksRepo}" && git add theirs.txt && git -c user.name=Pat -c user.email=pat@other.test commit -q -m theirs`]);
    const before = ran("preRun").length;
    const untrusted = collect({});
    if (!untrusted.includes("Hooks skipped (preRun): this branch has commits by Pat <pat@other.test>") || ran("preRun").length !== before || !untrusted.includes("Diff file"))
      fail(`preRun ran another author's code, or collect stopped:\n${untrusted}`);
    run("node", [join(root, "dist/skill/scripts/checks.mjs"), "--repo", hooksRepo, "--trust", "--run", "x=echo ok", "--out", join(tmp, "hooks-checks.json")], env);
    collect({});
    if (ran("preRun").length !== before + 1) fail("preRun did not run once the other author was trusted");
    try {
      collect({}, "--base", "no-such-branch");
      fail("collect.mts went on with a base branch that does not exist");
    } catch (error) {
      const e = error as ExecError;
      if (!e.stdout.includes("Hooks skipped (preRun): the base branch no-such-branch was not found") || ran("preRun").length !== before + 1) fail(`hooks ran without a base to check the authors against:\n${e.stdout}`);
    }
    console.log("hooks: preRun output and variables, a failing and a slow preRun, postRun once a round with only a warning on failure, onApproved once, and the trust rule all worked");
  } finally {
    try {
      review({}, "stop");
    } catch {
      // Already stopped.
    }
    github.close();
  }
}

// ------------------------------------------------------------------ screenshots
// screenshots.mts on a small app with a sign-in page (fixtures/make-shots-repo.sh): the plan checks, a skipped run,
// and, where a browser is on this machine, a whole run that signs in with the hook's test credentials, takes a flow
// and a single shot, keeps only references to changed files, runs the hooks after it and stops the app it started.
// Playwright comes from the viewer's packages; the browser is Playwright's Chromium or the installed Google Chrome.

async function screenshotsFlow() {
  const shotsRepo = join(tmp, "shots-books");
  run(bash, [join(root, "fixtures", "make-shots-repo.sh"), shotsRepo]);
  const data = join(shotsRepo, ".git/pr-report/feat-add-book");
  const home = join(tmp, "shots-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ screenshots: true }));
  const log = join(tmp, "shots-hooks.log");
  const logger = join(tmp, "log-shots-hook.mjs");
  writeFileSync(logger, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.HOOK_LOG, `${process.env.PR_REPORT_HOOK} ${process.env.PR_REPORT_SCREENSHOTS_RESULT}\\n`);\n');
  const logHook = `node "${logger.replaceAll("\\", "/")}"`;
  writeFileSync(
    join(shotsRepo, ".pr-report.json"),
    JSON.stringify({ hooks: { preScreenshots: "sh scripts/e2e-login.sh", onScreenshotsPassed: logHook, onScreenshotsFailed: logHook, postScreenshots: logHook } }),
  );
  const hooksRan = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const port = 5700 + Math.floor(Math.random() * 300);
  const env = { PR_REPORT_HOME: home, PR_REPORT_PLAYWRIGHT: join(root, "viewer/node_modules/playwright-core"), HOOK_LOG: log };
  const script = join(root, "dist/skill/scripts/screenshots.mjs");
  const shots = (...a: string[]) => run("node", [script, "--repo", shotsRepo, ...a], env);
  const shotsExit = (...a: string[]) => {
    try {
      return { code: 0, out: shots(...a) };
    } catch (e) {
      return { code: (e as ExecError & { status?: number }).status ?? 1, out: String((e as ExecError).stdout ?? "") };
    }
  };
  const readRun = () => JSON.parse(readFileSync(join(data, "screenshots.json"), "utf8")) as Bundle["screenshots"] & object;

  const collected = run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", shotsRepo, "--no-fetch", "--base", "main"], env);
  if (!/Screenshots: on \(turned on in Settings\), 1 changed UI file\./.test(collected)) fail(`collect did not point the agent at screenshots.md for a UI change:\n${collected}`);

  const status = shots("--status");
  if (!status.includes("Screenshots setting: on") || !status.includes("App: none saved") || !status.includes("the preScreenshots hook sets up a test login")) fail(`screenshots --status:\n${status}`);

  const badPlan = join(tmp, "shots-bad-plan.json");
  writeFileSync(badPlan, JSON.stringify({ sets: [{ id: "Bad Id", shape: "carousel", title: "", auth: "maybe", steps: [{ do: [{ teleport: "/" }] }] }] }));
  const bad = shotsExit("--run", "--plan", badPlan);
  for (const expected of ["id must be lowercase", "shape is flow, states or single", "auth is signed-in or signed-out", "needs a title", 'needs a caption in "shot"', "unknown action"]) {
    if (bad.code !== 2 || !bad.out.includes(expected)) fail(`a broken plan was not refused with "${expected}" (exit ${bad.code}):\n${bad.out}`);
  }

  shots("--skip", "Nothing a user sees changed.");
  const skipped = readRun();
  if (skipped.skipped !== "Nothing a user sees changed." || skipped.result !== "failed" || skipped.status !== "done") fail(`--skip did not record why: ${JSON.stringify(skipped)}`);
  if (hooksRan().join(",") !== "onScreenshotsFailed failed,postScreenshots failed") fail(`a skipped run did not run the failed and post hooks: ${hooksRan().join(", ")}`);
  rmSync(log, { force: true });

  const detected = JSON.parse(run("node", [script, "--detect"], env)) as { playwright: { found: boolean }; chromium: { found: boolean }; chrome: { found: boolean } };
  if (!detected.playwright.found) fail(`screenshots --detect did not find the Playwright named by PR_REPORT_PLAYWRIGHT: ${JSON.stringify(detected)}`);
  if (!detected.chromium.found && !detected.chrome.found) {
    console.log("screenshots: plan checks, --status and --skip worked; the browser run was skipped (neither Playwright's Chromium nor Google Chrome is installed)");
    return;
  }

  shots("--save", "--url", `http://127.0.0.1:${port}`, "--start", `PORT=${port} node server.mjs`, "--source", "the dev script", "--from", "package.json");
  const prepared = shots("--prepare");
  if (!prepared.includes(`App ready at http://127.0.0.1:${port} (started by this script`) || !prepared.includes("the hook wrote test credentials")) fail(`screenshots --prepare:\n${prepared}`);

  const plan = join(tmp, "shots-plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      login: { path: "/login", do: [{ fill: ["role=textbox[name='Email']", "$username"] }, { fill: ["role=textbox[name='Password']", "$password"] }, { click: "role=button[name='Sign in']" }] },
      sets: [
        {
          id: "add-book",
          shape: "flow",
          title: "Adding a book",
          summary: "Readers can add a book from their list.",
          auth: "signed-in",
          steps: [
            { do: [{ goto: "/books" }], shot: "Add book button added above the list", refs: ["books.html:2", "server.mjs:1"] },
            { do: [{ click: "role=button[name='Add book']" }], shot: "The new Add a book dialog" },
            { do: [{ fill: ["role=textbox[name='Title']", "Hyperion"] }, { click: "role=button[name='Save']" }, { waitFor: "text=Hyperion" }], shot: "The book appears in the list" },
          ],
        },
        { id: "visitors", shape: "single", title: "Signed-out visitors", auth: "signed-out", steps: [{ do: [{ goto: "/books" }], shot: "Visitors are still sent to sign in" }] },
      ],
    }),
  );
  shots("--login", "--plan", plan);
  const after = shots("--inspect", "--plan", plan, "--after", "add-book:2");
  if (!after.includes('dialog "Add a book"') || !after.includes("add-book-after-2-signed-in.png")) fail(`--inspect --after did not show the page where the steps leave it:\n${after}`);
  const ranOut = shots("--run", "--plan", plan);
  const done = readRun();
  const all = done.sets.flatMap((set) => set.shots);
  if (done.result !== "passed" || all.length !== 4 || all.some((shot) => shot.status !== "taken" || !shot.file || !existsSync(join(data, shot.file)) || !shot.width)) fail(`the screenshots run did not take every shot:\n${ranOut}`);
  if (all.some((shot) => !/^shots\/[0-9a-f]{16}\.png$/.test(shot.file ?? ""))) fail(`screenshots are not named by their content: ${all.map((shot) => shot.file).join(", ")}`);
  if (JSON.stringify(all[0].refs) !== JSON.stringify([{ path: "books.html", line: 2 }]) || !ranOut.includes("server.mjs is not changed by this branch")) fail(`a reference to a file the branch does not change was kept: ${JSON.stringify(all[0].refs)}`);
  if (readFileSync(join(data, "screenshots/plan.json"), "utf8") !== readFileSync(plan, "utf8")) fail("the plan was not kept for the next round");
  if (hooksRan().join(",") !== "onScreenshotsPassed passed,postScreenshots passed") fail(`the hooks after a passing run: ${hooksRan().join(", ")}`);
  const stillUp = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
  if (stillUp) fail("the app started by --prepare was still running after --run");

  // A later run keeps the pictures of the earlier one, so a comment on one still shows it.
  const before = all.map((shot) => shot.file!);
  writeFileSync(join(shotsRepo, "books.html"), readFileSync(join(shotsRepo, "books.html"), "utf8").replace("Your books", "My books"));
  shots("--prepare");
  shots("--run", "--plan", plan);
  const after2 = readRun().sets.flatMap((set) => set.shots.map((shot) => shot.file!));
  if (before.some((file) => !existsSync(join(data, file))) || after2[0] === before[0]) fail(`a new run did not keep the earlier pictures or did not take a new one: ${JSON.stringify({ before, after: after2 })}`);

  const built = run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(data, "diff.json"), "--draft", "--out", join(tmp, "shots-bundle.json"), "--html", join(tmp, "shots.html")]);
  const bundle = JSON.parse(readFileSync(join(tmp, "shots-bundle.json"), "utf8")) as Bundle;
  if (bundle.screenshots?.sets.length !== 2 || bundle.screenshots.sets[0].shots.some((shot) => shot.src)) fail(`build did not carry the screenshots, or put the pictures in the JSON: ${built}`);
  if ((readFileSync(join(tmp, "shots.html"), "utf8").match(/data:image\/png;base64,/g) ?? []).length !== 4) fail("the exported page does not carry the four pictures");
  console.log("screenshots: plan checks, --skip, a signed-in flow and a signed-out shot, references, the hooks after a run, stopping the app, and the build and export all worked");
}

// ------------------------------------------------------------------ Reflektor
// Publishing to Reflektor (reflektor.mts) against a local stand-in for its API: the login file, the device flow's
// answers, the preflight that keeps code from unapproved repos on the machine, the gzipped upload, and each refusal.
// Then review.mjs login, whoami and logout, and a private daemon publishing by itself while the pull request is open:
// once per snapshot, also across a restart, never a draft, not with the setting off, not after the pull request closed.

async function reflektorFlow() {
  const stub = await startReflektorStub();
  const github = await startGithubStub();
  const client = (await fromPackage("reflektor.mjs")) as typeof import("../skill/scripts/reflektor.mjs");
  type Outcome = Awaited<ReturnType<typeof client.publishBundle>>;
  const bundle = JSON.parse(readFileSync(join(root, "samples/bundle.json"), "utf8")) as Bundle;
  const home = join(tmp, "reflektor-home");
  const file = join(home, "reflektor.json");
  const login = { apiUrl: stub.url, appUrl: stub.url, token: STUB_TOKEN, user: STUB_USER, savedAt: new Date().toISOString(), organizations: {} };
  const acme = { slug: "acme", name: "Acme" };
  const beta = { slug: "beta", name: "Beta" };
  const ownerOnly = (f: string) => process.platform === "win32" || (statSync(f).mode & 0o777) === 0o600;
  const posts = (path: string) => stub.requests.filter((q) => q.method === "POST" && q.path === path).length;
  const codeOf = (e: unknown) => (e as { code?: string }).code;
  // review.mjs, run without blocking: the stand-ins live in this process and must be free to answer.
  const cli = (env: NodeJS.ProcessEnv, ...a: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile("node", [join(root, "dist/skill/scripts/review.mjs"), ...a], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }, (e, stdout, stderr) =>
        done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` }),
      ),
    );
  const dhome = join(tmp, "reflektor-daemon-home");
  const env = {
    PR_REPORT_HOME: dhome,
    PR_REPORT_PORT: String(5800 + Math.floor(Math.random() * 300)),
    PR_REPORT_DRIFT_SECONDS: "1",
    PR_REPORT_GITHUB_API: github.url,
    PR_REPORT_GITHUB_TOKEN: "stub-token",
    PR_REPORT_PR_POLL_SECONDS: "1",
    GH_CONFIG_DIR: join(tmp, "gh-config"),
    PR_REPORT_AGENT: "claude-code",
  };
  const review = (...a: string[]) => run("node", [join(root, "dist/skill/scripts/review.mjs"), ...a], env);

  try {
    // The login file: the user's only, read back as saved, and logout deletes it and nothing else.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), "{}");
    client.saveLogin(login, file);
    if (!ownerOnly(file)) fail("the Reflektor login file can be read by other users");
    chmodSync(file, 0o644);
    client.saveLogin(login, file);
    if (!ownerOnly(file)) fail("saving the Reflektor login over a file others could read left it readable");
    if (client.readLogin(file)?.token !== STUB_TOKEN || client.readLogin(file)?.user.email !== STUB_USER.email) fail("the Reflektor login does not read back as saved");
    writeFileSync(file, JSON.stringify({ ...login, apiUrl: "http://reflektor.example.test" }));
    if (client.readLogin(file) !== null) fail("a Reflektor login whose API is plain http on another machine was taken");
    if (!client.forgetLogin(file) || existsSync(file) || !existsSync(join(home, "settings.json"))) fail("logout did not delete exactly the login file");
    if (client.forgetLogin(file)) fail("logging out with no login file says it signed out");

    // Where to sign in: the variables, then the settings, then Reflektor's own; https only, except on this machine.
    const settings = { subagents: false, screenshots: false, reflektorAutoPublish: true, reflektorApiUrl: "https://api.example.test/", reflektorAppUrl: "" };
    const fromSettings = client.reflektorConfig(settings, {});
    const fromEnv = client.reflektorConfig(settings, { REFLEKTOR_API_URL: stub.url, REFLEKTOR_APP_URL: `${stub.url}/` });
    if (fromSettings.apiUrl !== "https://api.example.test" || fromSettings.appUrl !== "https://reflektor.dev" || fromEnv.apiUrl !== stub.url || fromEnv.appUrl !== stub.url)
      fail(`the Reflektor URLs do not come from the variables, then the settings: ${JSON.stringify({ fromSettings, fromEnv })}`);
    try {
      client.reflektorConfig(settings, { REFLEKTOR_API_URL: "http://reflektor.example.test" });
      fail("a plain http Reflektor API on another machine was accepted");
    } catch (e) {
      if (codeOf(e) !== "bad_url") fail(`a plain http Reflektor API failed the wrong way: ${(e as Error).message}`);
    }

    // The device flow: it waits the interval between polls, 5 seconds more after slow_down, and ends on approval,
    // denial or expiry. The waits are recorded instead of slept.
    const config = { apiUrl: stub.url, appUrl: stub.url };
    const pending: StubAnswer = { status: 400, body: { error: "authorization_pending" } };
    const waits: number[] = [];
    stub.device([pending, { status: 400, body: { error: "slow_down" } }, pending], { interval: 1 });
    const start = await client.startDeviceLogin(config, "pr-report on test-box");
    if ((stub.requests.find((q) => q.path === "/auth/device")?.json as { clientName?: string } | null)?.clientName !== "pr-report on test-box" || start.userCode !== "ABCD-EFGH")
      fail("the device login did not name this client, or did not hand back the code");
    const approved = await client.finishDeviceLogin(config, start, { sleep: async (ms) => void waits.push(ms) });
    if (approved.token !== STUB_TOKEN || approved.user.email !== STUB_USER.email || approved.apiUrl !== stub.url) fail(`the approved device login is not the stub's account: ${JSON.stringify(approved)}`);
    if (waits.join() !== "1000,1000,6000,6000") fail(`the device flow did not wait its interval, and 5 seconds more after slow_down: ${waits.join()}`);
    // With no app URL named, a login takes the app from the sign-in page the API sends, so a self-hosted Reflektor
    // links to itself. A named one stays.
    stub.device([]);
    const unnamed = await client.finishDeviceLogin({ apiUrl: stub.url, appUrl: "https://reflektor.dev", appUrlSet: false }, await client.startDeviceLogin(config), { sleep: async () => {} });
    stub.device([]);
    const named = await client.finishDeviceLogin({ apiUrl: stub.url, appUrl: "https://app.example.test", appUrlSet: true }, await client.startDeviceLogin(config), { sleep: async () => {} });
    if (unnamed.appUrl !== stub.url || named.appUrl !== "https://app.example.test") fail(`the login's app URL is not the sign-in page's, or overrode a named one: ${JSON.stringify([unnamed.appUrl, named.appUrl])}`);
    // The API URL from Settings: trimmed, Reflektor's own saved as empty, plain http off this machine refused.
    if (client.settingApiUrl(" https://api.example.test/ ") !== "https://api.example.test" || client.settingApiUrl("https://api.reflektor.dev/") !== "" || client.settingApiUrl("  ") !== "" || client.settingApiUrl("http://localhost:3000") !== "http://localhost:3000")
      fail("the Settings API URL is not saved as a base URL, empty for Reflektor's own");
    if (codeOf(await Promise.resolve().then(() => client.settingApiUrl("http://reflektor.example.test")).catch((e: unknown) => e)) !== "bad_url") fail("a plain http API URL off this machine was taken from Settings");
    const ending = async (answers: StubAnswer[], options: Parameters<typeof stub.device>[1] = {}) => {
      let clock = 0;
      stub.device(answers, options);
      const code = await client.startDeviceLogin(config);
      return client.finishDeviceLogin(config, code, { sleep: async (ms) => void (clock += ms), now: () => clock }).then(
        () => "approved",
        (e) => codeOf(e),
      );
    };
    if ((await ending([pending, { status: 400, body: { error: "access_denied" } }])) !== "access_denied") fail("a denied device login did not end as denied");
    if ((await ending([{ status: 400, body: { error: "expired_token" } }])) !== "expired_token") fail("an expired device code did not end the login");
    const polls = posts("/auth/device/token");
    if ((await ending([], { then: "pending", interval: 1, expiresIn: 3 })) !== "expired_token" || posts("/auth/device/token") - polls > 4) fail("a device login nobody approves did not stop when its code expired");

    // whoami, and a revoked token.
    if ((await client.whoami(login)).email !== STUB_USER.email) fail("whoami did not answer the stub's account");
    stub.failNext("/auth/me", { status: 401, body: { error: "unauthorized" } });
    if (await client.whoami(login).then(() => "ok", codeOf) !== "unauthorized") fail("a revoked token did not fail whoami as unauthorized");

    // Publishing: never a draft, nothing before the preflight names an organization, and the bundle gzipped with the
    // token. The preflight sends the repository's name and nothing else.
    const publish = (b: Bundle, options: { organization?: string } = {}, as = login) => client.publishBundle(as, b, options);
    const reasonOf = (o: Outcome) => (o.ok ? "ok" : o.reason);
    const asked = stub.requests.length;
    const draft = await publish({ ...bundle, draft: true });
    if (draft.ok || draft.reason !== "draft" || stub.requests.length !== asked) fail("a draft was published, or Reflektor was asked about it");
    stub.organizations([]);
    const unapproved = await publish(bundle);
    if (unapproved.ok || unapproved.reason !== "not_approved" || posts("/reports") !== 0) fail(`a repo no organization approves was uploaded: ${JSON.stringify(unapproved)}`);
    if (JSON.stringify(stub.requests.at(-1)?.json) !== JSON.stringify({ repository: { host: "github.com", owner: "acme-labs", name: "library" } })) fail("the preflight sent more than the repository's name");
    stub.organizations([acme]);
    const one = await publish(bundle);
    const sent = stub.requests.at(-1)!;
    if (!one.ok || one.organization !== "acme" || !one.created || one.round !== 1 || !one.report.url) fail(`publishing to the one organization that approves the repo did not work: ${JSON.stringify(one)}`);
    if (sent.headers["content-encoding"] !== "gzip" || sent.headers["content-type"] !== "application/json" || sent.headers.authorization !== `Bearer ${STUB_TOKEN}`)
      fail(`the upload lacks its headers: ${JSON.stringify(sent.headers)}`);
    const body = JSON.parse(gunzipSync(sent.bytes).toString("utf8")) as { organization?: string; bundle?: Bundle };
    if (body.organization !== "acme" || JSON.stringify(body.bundle) !== JSON.stringify(client.withoutLocalPaths(bundle))) fail("the upload's body is not the gzipped bundle with its organization");
    if (body.bundle?.diff.repo.root !== "" || body.bundle?.diff.repo.gitDir !== "" || (body.bundle?.projectChecks && body.bundle.projectChecks.file !== ""))
      fail("the upload sent paths on this machine");
    const reviewed = { round: 1, branch: "feat/books", headSha: "a".repeat(40), snapshot: "b".repeat(40), submittedAt: "2026-11-15T00:00:00Z", comments: [] };
    const carried = client.withoutLocalPaths({ ...bundle, previousReview: { version: 1, ...reviewed, report: "/home/dev/books/.git/pr-report/r1.json" } as Bundle["previousReview"] });
    if (!carried.previousReview || "report" in carried.previousReview) fail("the upload sent the local path of the report a review was sent on");
    const twice = await publish(bundle);
    if (!twice.ok || twice.created) fail("an upload of a snapshot the platform had already did not say so");

    // Screenshots: the bundle goes without local paths or pictures inside it, then the pictures the report lacks go one
    // by one, and none again once it has them. With "upload": false in the repo config, the report goes without them.
    const shotsDir = join(tmp, "reflektor-shots");
    mkdirSync(join(shotsDir, "shots"), { recursive: true });
    const picture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
    const pictureName = `${createHash("sha1").update(picture).digest("hex").slice(0, 16)}.png`;
    writeFileSync(join(shotsDir, "shots", pictureName), picture);
    const shot = { id: "s-1", caption: "A shot", refs: [], status: "taken" as const, file: `shots/${pictureName}`, width: 10, height: 10, error: null, src: "data:image/png;base64,AA" };
    const withShots: Bundle = {
      ...bundle,
      diff: { ...bundle.diff, branch: { ...bundle.diff.branch, snapshot: "shots-snapshot" } },
      screenshots: { status: "done", result: "passed", startedAt: null, ranAt: null, headSha: "x", skipped: null, file: join(shotsDir, "screenshots.json"), sets: [{ id: "s", shape: "single", title: "S", summary: null, auth: "signed-out", shots: [shot] }] },
    };
    const puts = () => stub.requests.filter((q) => q.method === "PUT" && q.path.endsWith(`/screenshots/${pictureName}`));
    const shotsOut = await publish(withShots);
    const shotsBody = stub.uploads().at(-1)?.bundle as unknown as Bundle;
    if (!shotsOut.ok || shotsOut.screenshots?.sent !== 1 || puts().length !== 1 || !puts()[0].bytes.equals(picture)) fail(`the screenshots did not go up after the report: ${JSON.stringify(shotsOut)}`);
    if (shotsBody.screenshots?.file !== "" || "src" in (shotsBody.screenshots?.sets[0].shots[0] ?? {})) fail("the upload sent a local path or a picture inside the bundle");
    await publish(withShots);
    if (puts().length !== 1) fail("a picture Reflektor already had was sent again");
    const optedOut: Bundle = { ...withShots, diff: { ...withShots.diff, branch: { ...withShots.diff.branch, snapshot: "shots-off" }, config: { ...(withShots.diff.config ?? {}), screenshots: { upload: false } } } };
    const off = await publish(optedOut);
    if (!off.ok || off.screenshots || (stub.uploads().at(-1)?.bundle as unknown as Bundle).screenshots !== null) fail("screenshots went to Reflektor for a repo that turned uploading off");

    // Several organizations: the one asked for, else the one saved for the repo, else the list to choose from.
    stub.organizations([acme, beta]);
    const uploads = posts("/reports");
    const several = await publish(bundle);
    if (several.ok || several.reason !== "organization_required" || several.organizations?.length !== 2 || posts("/reports") !== uploads) fail(`several organizations did not ask which one: ${JSON.stringify(several)}`);
    if (!(await publish(bundle, { organization: "beta" })).ok || (stub.uploads().at(-1)?.organization !== "beta")) fail("publishing to the organization asked for did not go there");
    const saved = await publish(bundle, {}, { ...login, organizations: { "github.com/acme-labs/library": "beta" } });
    if (!saved.ok || saved.organization !== "beta") fail("the organization saved for the repo was not used");
    if (reasonOf(await publish(bundle, { organization: "nope" })) !== "unknown_organization") fail("an organization that does not approve the repo was not refused");

    // What the upload can answer, each in words the reader can act on.
    stub.organizations([acme]);
    const refusals: [string, string, StubAnswer, (o: Outcome & { ok: false }) => boolean][] = [
      ["/reports", "organization_required", { status: 409, body: { error: "organization_required", organizations: [acme, beta] } }, (o) => o.organizations?.length === 2],
      ["/reports", "repository_not_approved", { status: 403, body: { error: "repository_not_approved" } }, (o) => o.message.includes("admin")],
      ["/reports", "not_a_member", { status: 403, body: { error: "not_a_member" } }, (o) => o.message.includes("not a member")],
      ["/reports/preflight", "unauthorized", { status: 401, body: { error: "unauthorized" } }, (o) => o.message.includes("Sign in again")],
      ["/reports", "rate_limited", { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "120" } }, (o) => o.retryAfterMs === 120_000],
      ["/reports", "too_large", { status: 413, body: { error: "too_large" } }, (o) => o.message.includes("25 MB")],
      ["/reports", "invalid_bundle", { status: 400, body: { error: "invalid_bundle", issues: [{ path: ["diff", "files", 0, "path"], message: "Required" }] } }, (o) => o.message.includes("diff.files.0.path: Required")],
    ];
    for (const [path, reason, answer, test] of refusals) {
      stub.failNext(path, answer);
      const o = await publish(bundle);
      if (o.ok || o.reason !== reason || !test(o)) fail(`a ${answer.status} from ${path} did not end as ${reason}: ${JSON.stringify(o)}`);
    }
    if (reasonOf(await publish(bundle, {}, { ...login, apiUrl: "http://127.0.0.1:9" })) !== "network") fail("a Reflektor that does not answer did not end as a network problem");

    // review.mjs login, whoami and logout, against the stand-in.
    const cliHome = { PR_REPORT_HOME: join(tmp, "reflektor-cli-home"), REFLEKTOR_API_URL: stub.url, REFLEKTOR_APP_URL: stub.url };
    const loginFile = join(cliHome.PR_REPORT_HOME, "reflektor.json");
    stub.device([pending]);
    const signedIn = await cli(cliHome, "login", "--no-open");
    if (signedIn.code !== 0 || !signedIn.out.includes("ABCD-EFGH") || !signedIn.out.includes("Signed in to Reflektor as Ada Lovelace <ada@example.test>")) fail(`review.mjs login did not sign in:\n${signedIn.out}`);
    if (!existsSync(loginFile) || !ownerOnly(loginFile) || client.readLogin(loginFile)?.apiUrl !== stub.url) fail("review.mjs login did not save the login for the user only, with its API");
    if (!(await cli(cliHome, "whoami")).out.includes("as Ada Lovelace <ada@example.test>")) fail("review.mjs whoami did not name the account");
    stub.failNext("/auth/me", { status: 401, body: { error: "unauthorized" } });
    const revoked = await cli(cliHome, "whoami");
    if (revoked.code !== 1 || !revoked.out.includes("Sign in again with")) fail(`review.mjs whoami with a revoked token did not say to sign in again:\n${revoked.out}`);
    const loggedOut = await cli(cliHome, "logout");
    if (!loggedOut.out.includes("Signed out of Reflektor") || existsSync(loginFile)) fail(`review.mjs logout did not delete the login:\n${loggedOut.out}`);
    if (!(await cli(cliHome, "whoami")).out.includes("Not signed in")) fail("review.mjs whoami after logout does not say so");
    stub.device([{ status: 400, body: { error: "access_denied" } }]);
    const denied = await cli(cliHome, "login", "--no-open");
    if (denied.code !== 1 || !denied.out.includes("denied") || existsSync(loginFile)) fail(`a denied review.mjs login did not end clearly:\n${denied.out}`);
    const cleartext = await cli({ ...cliHome, REFLEKTOR_API_URL: "http://reflektor.example.test" }, "login", "--no-open");
    if (cleartext.code !== 1 || !cleartext.out.includes("must use https")) fail(`review.mjs login took a plain http API on another machine:\n${cleartext.out}`);

    // The daemon publishes by itself: a fresh books repo, its review on screen, and its pull request on the GitHub stub.
    const repoDir = join(tmp, "reflektor-books");
    run(bash, [join(root, "fixtures", "make-books-repo.sh"), repoDir]);
    const data = join(repoDir, ".git/pr-report/feat-books");
    const collect = () => run("node", [join(root, "dist/skill/scripts/collect.mjs"), "--repo", repoDir, "--no-fetch"], env);
    const build = (...a: string[]) => run("node", [join(root, "dist/skill/scripts/build.mjs"), "--diff", join(data, "diff.json"), ...a]).match(/Wrote (\S+)/)![1];
    const finished = () => build("--report", join(root, "samples/report.json"));
    const snapshotOf = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as Bundle).diff.branch.snapshot;
    // New code: a line more in a file, collected again.
    let edits = 0;
    const edit = () => {
      appendFileSync(join(repoDir, "apps/web/src/api/books.ts"), `// edit ${++edits}\n`);
      collect();
    };
    collect();
    const first = finished();
    const opened = review("open", "--report", first);
    const id = opened.match(/Review id: (\S+)/)?.[1];
    if (!id) return fail(`review.mjs open printed no review id:\n${opened}`);
    const daemonUrl = () => `http://127.0.0.1:${(JSON.parse(readFileSync(join(dhome, "daemon.json"), "utf8")) as DaemonFile).port}`;
    const page = await (await fetch(`${daemonUrl()}/r/${id}`)).text();
    const pageConfig = JSON.parse(page.match(/window.__PR_REVIEW__=(\{.*?\})<\/script>/)![1]) as ReviewConfig;
    const asPage = { "x-review-token": pageConfig.token, "content-type": "application/json" };
    const onScreen = () => fetch(`${daemonUrl()}${pageConfig.api}/presence`, { method: "POST", headers: asPage, body: JSON.stringify({ tab: "t1" }) }).catch(() => {});
    const state = async (): Promise<LiveState> => {
      const res = await fetch(`${daemonUrl()}/api/events?token=${pageConfig.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      return JSON.parse(new TextDecoder().decode(value).match(/data: (.*)/)![1]);
    };
    const waitFor = async (test: () => boolean | Promise<boolean>, tries = 50) => {
      for (let i = 0; i < tries; i++) {
        await onScreen();
        if (await test()) return true;
        await sleep(200);
      }
      return false;
    };
    // A few of the daemon's ticks, with the review on screen.
    const ticks = async () => {
      for (let i = 0; i < 5; i++) {
        await onScreen();
        await sleep(500);
      }
    };
    const uploaded = () => stub.uploads().length;
    const show = (f: string) => review("open", "--report", f);

    github.set([githubPr(7, "open")]);
    if (!(await waitFor(async () => (await state()).pr?.state === "OPEN"))) fail("the reflektor daemon did not see the pull request open");
    const before = stub.requests.length;
    await ticks();
    if (stub.requests.length !== before) fail("the daemon called Reflektor before anyone signed in");

    // Signed in: the round goes up, once, however many ticks, rebuilds of the same code and restarts follow.
    const daemonLogin = join(dhome, "reflektor.json");
    client.saveLogin(login, daemonLogin);
    const already = uploaded();
    if (!(await waitFor(() => uploaded() === already + 1))) fail("the daemon did not publish once signed in with the pull request open");
    if (stub.uploads().at(-1)?.bundle.diff.branch.snapshot !== snapshotOf(first)) fail("the daemon did not publish the round on screen");
    if (stub.uploads().at(-1)?.bundle.diff.branch.pr?.number !== 7) fail("the daemon did not send the pull request it knows with a round built before it");
    if (!(await waitFor(async () => Boolean((await state()).reflektor?.published?.url)))) fail("the page state does not say where the report went");
    await ticks();
    show(finished());
    await ticks();
    if (uploaded() !== already + 1) fail(`the same snapshot went to Reflektor ${uploaded() - already} times`);
    review("stop");
    show(finished());
    await ticks();
    if (uploaded() !== already + 1) fail("a restarted daemon sent a snapshot it had sent before");
    const byHand = await cli(env, "publish", "--id", id);
    if (!byHand.out.includes("is on Reflektor already") || uploaded() !== already + 1) fail(`review.mjs publish sent a snapshot again, or did not say where it is:\n${byHand.out}`);

    // New code while the pull request is open goes up; a draft does not, its finished build does.
    edit();
    const second = finished();
    show(second);
    if (!(await waitFor(() => uploaded() === already + 2)) || stub.uploads().at(-1)?.bundle.diff.branch.snapshot !== snapshotOf(second)) fail("a later build with the pull request open was not published");
    edit();
    show(build("--draft"));
    await ticks();
    if (uploaded() !== already + 2 || stub.uploads().some((u) => u.bundle.draft)) fail("a draft was published");
    show(finished());
    if (!(await waitFor(() => uploaded() === already + 3))) fail("the finished build after a draft was not published");

    // The setting off: nothing goes up. Turned on again, the build waiting goes.
    writeFileSync(join(dhome, "settings.json"), JSON.stringify({ reflektorAutoPublish: false }));
    edit();
    show(finished());
    await ticks();
    if (uploaded() !== already + 3) fail("the daemon published with auto-publish turned off");
    writeFileSync(join(dhome, "settings.json"), "{}");
    if (!(await waitFor(() => uploaded() === already + 4))) fail("turning auto-publish on again did not publish the round waiting");

    // A repo no organization approves: nothing uploaded, the reason in the page state, and no new try every tick.
    stub.organizations([]);
    edit();
    show(finished());
    if (!(await waitFor(async () => (await state()).reflektor?.error?.reason === "not_approved"))) fail("a publish refused by the preflight did not reach the page state");
    const preflights = posts("/reports/preflight");
    await ticks();
    if (uploaded() !== already + 4 || posts("/reports/preflight") !== preflights) fail("the daemon uploaded an unapproved repo, or kept asking about it every tick");

    // The repo approved by the next build: it goes at once, not when the refusal's wait is over.
    stub.organizations([acme]);
    edit();
    show(finished());
    if (!(await waitFor(() => uploaded() === already + 5))) fail("a new build waited out the retry time of the build refused before it");

    // Several organizations: the daemon does not pick one. From the page: the list first, then the one picked, which
    // is saved for the repo, so the daemon's next publish goes there by itself.
    stub.organizations([acme, beta]);
    edit();
    show(finished());
    if (!(await waitFor(async () => (await state()).reflektor?.error?.reason === "organization_required")) || uploaded() !== already + 5)
      fail("the daemon picked an organization by itself, or did not say it needs one");
    const publishFromPage = async (body: object) => (await (await fetch(`${daemonUrl()}${pageConfig.api}/reflektor`, { method: "POST", headers: asPage, body: JSON.stringify(body) })).json()) as { ok: boolean; reason: string | null; organizations?: unknown[] };
    const choose = await publishFromPage({});
    if (choose.ok || choose.reason !== "organization_required" || choose.organizations?.length !== 2) fail(`publishing from the page with several organizations did not ask which: ${JSON.stringify(choose)}`);
    const picked = await publishFromPage({ organization: "beta" });
    if (!picked.ok || uploaded() !== already + 6 || stub.uploads().at(-1)?.organization !== "beta") fail(`publishing from the page to the organization picked did not work: ${JSON.stringify(picked)}`);
    if (client.readLogin(daemonLogin)?.organizations?.["github.com/acme-labs/library"] !== "beta") fail("the organization picked was not saved for the repo");
    edit();
    show(finished());
    if (!(await waitFor(() => uploaded() === already + 7)) || stub.uploads().at(-1)?.organization !== "beta") fail("the daemon did not publish to the organization saved for the repo");

    // A closed pull request: new code stays here.
    github.set([githubPr(7, "closed")]);
    if (!(await waitFor(async () => (await state()).pr?.state === "CLOSED"))) fail("the reflektor daemon did not see the pull request closed");
    stub.organizations([acme]);
    edit();
    show(finished());
    await ticks();
    if (uploaded() !== already + 7) fail("the daemon published after the pull request was closed");

    // The page's menu: who is signed in, and signing out there.
    const status = (await (await fetch(`${daemonUrl()}/api/reflektor`, { headers: asPage })).json()) as { signedIn: boolean; user: { email: string } | null };
    if (!status.signedIn || status.user?.email !== STUB_USER.email) fail(`the page is not told who is signed in to Reflektor: ${JSON.stringify(status)}`);
    if ((await fetch(`${daemonUrl()}/api/reflektor`)).status !== 401) fail("the Reflektor status answers without the page token");
    const out = (await (await fetch(`${daemonUrl()}/api/reflektor/logout`, { method: "POST", headers: asPage })).json()) as { signedIn: boolean };
    if (out.signedIn || existsSync(daemonLogin)) fail("signing out from the page did not delete the login");
    console.log(
      "reflektor: login file for the user only, device flow (pending, slow_down, denied, expired), whoami, preflight before any upload, gzipped upload, refusals, review.mjs login/whoami/logout/publish, auto-publish once per snapshot while the pull request is open, and the API URL from Settings all worked",
    );
  } finally {
    try {
      review("stop");
    } catch {
      // Already stopped.
    }
    stub.close();
    github.close();
  }
}

if (failed) process.exitCode = 1;
else console.log(`check passed: ${html}`);

if (!failed && process.argv.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [html], { detached: true, stdio: "ignore" }).unref();
}
