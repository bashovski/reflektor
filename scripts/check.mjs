#!/usr/bin/env node
// End-to-end check: rebuilds the fake books repo, runs collect.mjs and build.mjs on it with
// samples/report.json, and fails on any warning. Then drives a whole review through a private daemon.
// Also refreshes samples/bundle.json for `pnpm dev` and the standalone samples/books-report.html.
//
// Usage: node scripts/check.mjs [--open]

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBash } from "../skill/scripts/repo.mjs";
import { githubPr, startGithubStub } from "./github-stub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-check-"));
const repo = join(tmp, "books");
const html = join(root, "samples", "books-report.html");

// On Windows, the Git Bash that Claude Code uses, not the WSL one that "bash" can find first.
const bash = gitBash() ?? "bash";
const run = (cmd, args, env) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const fail = (message) => {
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
  const { detectAgent, decodeAgent, encodeAgent } = await import("../skill/scripts/agent.mjs");
  const elsewhere = join(root, "skill/scripts/review.mjs");
  const who = (options) => {
    const a = detectAgent({ env: {}, launchPath: elsewhere, ...options });
    return a ? `${a.id}|${a.name}|${a.product}|${a.resume}|${a.version}|${a.source}` : "nobody";
  };
  const agentCases = [
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

  // The PR type pill is drawn twice, by the viewer (TAGS in meta.ts) and by the inbox (TAGS in daemon.mjs), from two lists
  // that cannot share code: the daemon uses Node built-ins only. So the lists are compared here instead.
  // The third-party notices file ships with the skill and must name every package the viewer bundles.
  const notices = readFileSync(join(root, "skill/THIRD-PARTY-NOTICES.md"), "utf8");
  for (const dep of Object.keys(JSON.parse(readFileSync(join(root, "viewer/package.json"), "utf8")).dependencies))
    if (!notices.includes(`## ${dep} `)) fail(`THIRD-PARTY-NOTICES.md does not cover ${dep}; run node scripts/build-notices.mjs`);
  // So must source that was copied into the viewer by hand: each folder in viewer/src/vendor.
  const vendor = join(root, "viewer/src/vendor");
  for (const folder of existsSync(vendor) ? readdirSync(vendor) : [])
    if (!notices.includes(`## ${folder} `)) fail(`THIRD-PARTY-NOTICES.md does not cover viewer/src/vendor/${folder}; add it to COPIED in scripts/build-notices.mjs and run it`);

  const lucideName = (icon) => icon[0].toLowerCase() + icon.slice(1);
  const viewerTags = Object.fromEntries(
    [...readFileSync(join(root, "viewer/src/lib/meta.ts"), "utf8").matchAll(/^\s+([A-Z]+): \{ color: "(#[0-9a-f]{6})", icon: (\w+) \}/gm)].map(([, tag, color, icon]) => [tag, `${color} ${lucideName(icon)}`]),
  );
  const inboxTags = Object.fromEntries([...readFileSync(join(root, "skill/scripts/daemon.mjs"), "utf8").matchAll(/^\s+([A-Z]+): \["(#[0-9a-f]{6})", "(\w+)"\]/gm)].map(([, tag, color, icon]) => [tag, `${color} ${icon}`]));
  if (Object.keys(viewerTags).length < 7 || Object.keys(inboxTags).length < 7) fail(`could not read both tag lists (viewer ${Object.keys(viewerTags).length}, inbox ${Object.keys(inboxTags).length})`);
  for (const tag of new Set([...Object.keys(viewerTags), ...Object.keys(inboxTags)]))
    if (viewerTags[tag] !== inboxTags[tag]) fail(`the tag lists differ for ${tag}: viewer has ${viewerTags[tag] ?? "nothing"}, the inbox has ${inboxTags[tag] ?? "nothing"}`);

  // A private home, so avatars come only from what this check puts in its cache.
  const home = { PR_REPORT_HOME: join(tmp, "collect-home") };
  const collected = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"], home);
  if (!collected.includes("Patch coverage: 51%")) fail("collect.mjs did not read coverage from .pr-report.json");
  if (!collected.includes("(config)")) fail("collect.mjs did not take the base branch from .pr-report.json");
  if (!collected.includes("Safety checks: 1 high, 0 medium, 1 low")) fail("collect.mjs safety checks did not find the slug migration problems");
  // The reader's settings: collect says nothing of subagent mode while it is off. The run on the second repo, below, has it on.
  if (collected.includes("Subagent mode")) fail("collect.mjs speaks of subagent mode although the setting is off");
  const books = JSON.parse(readFileSync(join(repo, ".git/pr-report/feat-books/diff.json"), "utf8"));
  if (books.repo.avatar?.initials !== "AL" || books.repo.avatar.image !== null) fail(`acme-labs without a cached avatar should get initials AL: ${JSON.stringify(books.repo.avatar)}`);
  if (books.repo.web?.ownerUrl !== "https://github.com/acme-labs" || books.repo.web.forge !== "github") fail(`collect.mjs did not find the repo's web links: ${JSON.stringify(books.repo.web)}`);
  if (books.branch.upstream !== null) fail("feat/books is not on the remote, but collect.mjs says it is");

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
  // Subagent mode turned on in Settings, for this one run: collect has to say so and name the file with the steps.
  writeFileSync(join(home.PR_REPORT_HOME, "settings.json"), JSON.stringify({ subagents: true }));
  const edgeOut = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", edgeRepo, "--no-fetch", "--base", "main", "--out", join(tmp, "edge.json")], home);
  rmSync(join(home.PR_REPORT_HOME, "settings.json"));
  const told = edgeOut.match(/^Subagent mode: on .* Read (.+subagents\.md) before/m);
  if (!told || !existsSync(told[1])) fail("collect.mjs does not tell the agent that subagent mode is on, or the file it names with the steps is not there");
  if (!edgeOut.includes("AWS access key [AKIA…(20 characters)]")) fail("collect.mjs did not flag or mask a fake AWS key");
  const edgeData = JSON.parse(readFileSync(join(tmp, "edge.json"), "utf8"));
  if (!edgeData.repo.avatar?.image?.startsWith("data:image/png;base64,") || edgeData.repo.avatar.initials !== "EG")
    fail(`a cached avatar was not used: ${JSON.stringify(edgeData.repo.avatar).slice(0, 120)}`);
  const edge = Object.fromEntries(edgeData.files.map((f) => [f.path, f]));
  if (!edge["gen/api.js"]?.generated) fail("collect.mjs did not mark a linguist-generated file as generated");
  if (!edge["big.txt"]?.tooLarge || edge["big.txt"].newContent !== null) fail("collect.mjs did not leave out a file over the size limit");
  if (edge["naïve name.ts"]?.newContent !== "export const ok = true;\n") fail("collect.mjs did not read a file with a space and accent in its name");

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
  const edgeBuilt = run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(tmp, "edge.json"), "--report", join(tmp, "edge-report.json"), "--out", join(tmp, "edge-out", "edge-r1.json")]);
  const edgeContracts = JSON.parse(readFileSync(join(tmp, "edge-out", "edge-r1.json"), "utf8")).report.contracts;
  if (!edgeBuilt.includes('could not find "Nope"')) fail("build.mjs did not drop a made-up contract name");
  if (edgeBuilt.includes('member "')) fail(`build.mjs rejected a real contract member:\n${edgeBuilt}`);
  if (edgeContracts.map((c) => c.name).join() !== "Status,LIMIT,api") fail(`unexpected contracts after the build: ${edgeContracts.map((c) => c.name).join()}`);
  if (!edgeContracts.find((c) => c.name === "api")?.generated) fail("a contract in a generated file was not marked generated");

  // Base branch without a remote default or a config: the branch this one forked from, unless a
  // common name exists. "old" forked earlier, "feat-copy" holds every commit of feat, so neither counts.
  const basesRepo = join(tmp, "bases");
  mkdirSync(basesRepo, { recursive: true });
  const at = (date, cmd) => `GIT_AUTHOR_DATE="${date}" GIT_COMMITTER_DATE="${date}" git -c user.name=t -c user.email=t@t ${cmd}`;
  run(bash, ["-c", [
    `cd "${basesRepo}" && git init -q -b release`,
    `echo one > a.txt && git add a.txt && ${at("2024-01-01T10:00:00", "commit -q -m one")}`,
    `git checkout -qb old && echo old > old.txt && git add old.txt && ${at("2024-01-01T11:00:00", "commit -q -m old")}`,
    `git checkout -q release && echo two > a.txt && git add a.txt && ${at("2024-01-02T10:00:00", "commit -q -m two")}`,
    `git checkout -qb feat && echo three > a.txt && git add a.txt && ${at("2024-01-03T10:00:00", "commit -q -m three")}`,
    `git checkout -qb feat-copy && echo four > b.txt && git add b.txt && ${at("2024-01-04T10:00:00", "commit -q -m four")}`,
    `git checkout -q feat`,
  ].join(" && ")]);
  const collectBases = () => run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", basesRepo, "--no-fetch", "--out", join(tmp, "bases.json")], home);
  if (!collectBases().includes("feat → release (guess)")) fail("collect.mjs did not pick the branch feat forked from as the base");
  run(bash, ["-c", `cd "${basesRepo}" && git branch main release`]);
  if (!collectBases().includes("feat → main (guess)")) fail("collect.mjs did not prefer a common branch name over the fork point");

  // Saved checks: worked out once per repo and reused, skipped when nothing they cover changed, out
  // of date when the file they came from changes or a command is missing.
  const checks = (...a) => run("node", [join(root, "skill/scripts/checks.mjs"), "--repo", edgeRepo, ...a], home);
  const savedRun = join(tmp, "saved-checks.json");
  if (!checks("--plan").includes("No checks for this repo yet")) fail("checks.mjs --plan did not ask for checks in a repo without any");
  writeFileSync(join(edgeRepo, "package.json"), '{"scripts":{"lint":"echo ok"}}\n');
  checks("--save", "--source", "from package.json", "--from", "package.json", "--run", "lint=echo lint ok", "--run", "api=echo api", "--when", "api=api/**");
  if (!existsSync(join(home.PR_REPORT_HOME, "repos/gitlab.com/edge-group/sub/edge/checks.json"))) fail("saved checks are not stored under the repo's remote");
  const plan = checks("--plan");
  if (!plan.includes("saved for this repo") || !plan.includes("skipped, nothing it covers changed: api")) fail(`checks.mjs --plan did not use the saved checks:\n${plan}`);
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
  } catch (e) {
    if (e.status !== 4 || !e.stdout.includes("Not started")) fail(`checks without --trust did not refuse clearly: ${e.stdout}`);
  }
  if (!checks("--run", "x=echo ran", "--out", savedRun, "--trust").includes("Project checks: 1 passed")) fail("--trust did not start the checks");
  if (checks("--plan").includes("Ask the user")) fail("an author trusted with --trust was asked about again");
  checks("--forget");
  if (!checks("--plan").includes("Ask the user")) fail("--forget did not remove the trusted authors");

  const checked = run("node", [
    join(root, "skill/scripts/checks.mjs"), "--repo", repo,
    "--run", "whitespace=git diff --check HEAD",
    "--run", `typecheck=node -e "console.error('apps/api/src/books/book.service.ts(1,18): error TS7016: Could not find a declaration file for module isbn3.'); process.exit(2)"`,
    "--run", `tests=node -e "console.log('3 passed')"`,
  ]);
  if (!checked.includes("Project checks: 2 passed, 1 failed")) fail("checks.mjs did not report 2 passed and 1 failed");

  const built = run("node", [
    join(root, "skill/scripts/build.mjs"),
    "--diff", join(repo, ".git/pr-report/feat-books/diff.json"),
    "--report", join(root, "samples/report.json"),
    "--out", join(root, "samples/bundle.json"),
    "--html", html,
  ]);
  for (const line of built.split("\n").filter((l) => l.startsWith("warning:"))) fail(line);

  // A draft: the facts before the agent's report, every file listed, nothing that needs the report.
  run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--draft", "--out", join(tmp, "draft.json")]);
  const draft = JSON.parse(readFileSync(join(tmp, "draft.json"), "utf8"));
  const listed = draft.report.sections.flatMap((s) => s.files).length;
  if (!draft.draft || draft.prDescription !== null || listed !== draft.diff.files.length) fail(`a draft build is not a draft of every file: ${JSON.stringify({ draft: draft.draft, listed })}`);

  const bundle = JSON.parse(readFileSync(join(root, "samples/bundle.json"), "utf8"));
  const missingIcons = bundle.diff.files.filter((f) => !bundle.fileIcons?.byPath[f.path]);
  if (missingIcons.length) fail(`no file icon for ${missingIcons.length} files (run node scripts/build-icons.mjs)`);

  const page = readFileSync(html, "utf8");
  if (page.includes("__PR_REPORT_DATA__")) fail("report data was not injected into the viewer");
  // samples/ can hold review files from local runs, which makes this a later round.
  if (!/<title>feat\/books · library( · round \d+)?<\/title>/.test(page)) fail("the standalone page does not carry the branch · repo title");
  if (statSync(html).size < 1_000_000) fail("the standalone page is too small; build.mjs probably used the unbuilt viewer");

  // Checks started in the background: build does not wait and records them as running; --wait returns their results.
  const bgChecks = join(tmp, "bg-checks.json");
  spawn("node", [join(root, "skill/scripts/checks.mjs"), "--repo", repo, "--out", bgChecks, "--run", "slow=sleep 2"], { stdio: "ignore" });
  const started = () => {
    try {
      return readFileSync(bgChecks, "utf8").includes('"running"');
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && !started(); i++) await sleep(50);
  run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--report", join(root, "samples/report.json"), "--checks", bgChecks, "--out", join(tmp, "bg.json")]);
  const bgRun = JSON.parse(readFileSync(join(tmp, "bg.json"), "utf8")).projectChecks;
  if (bgRun?.status !== "running" || bgRun.pending.join() !== "slow" || bgRun.file !== bgChecks) fail(`build.mjs did not record the running checks: ${JSON.stringify(bgRun)}`);
  const waited = run("node", [join(root, "skill/scripts/checks.mjs"), "--repo", repo, "--out", bgChecks, "--wait"]);
  if (!waited.includes("Project checks: 1 passed")) fail(`checks.mjs --wait did not print the finished results:\n${waited}`);

  await daemonFlow();
  updateFlow();
  await concurrentStart();
} catch (e) {
  fail(e.stderr?.toString() || e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ app size
// The page's own scripts and styles load once and stay cached. Languages, themes and fonts load
// separately when needed, so this budget catches a build that bundles them into the entry again.
async function checkAppAssets(base, page) {
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
  const review = (...args) => run("node", [join(root, "skill/scripts/review.mjs"), ...args], env);
  // For a command the daemon answers only after asking the GitHub stub, which lives in this process:
  // a blocking call would keep the stub from answering.
  const reviewAsync = (...args) =>
    new Promise((resolveOut, reject) =>
      execFile("node", [join(root, "skill/scripts/review.mjs"), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }, (e, stdout) => (e ? reject(e) : resolveOut(stdout))),
    );
  const build = (out) =>
    run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/feat-books/diff.json"), "--report", join(root, "samples/report.json"), "--out", out]);
  try {
    build(join(reviewDir, "round1.json"));
    const opened = review("open", "--report", join(reviewDir, "round1.json"));
    const id = opened.match(/Review id: (\S+)/)?.[1];
    if (!id) return fail(`review.mjs open printed no id:\n${opened}`);

    const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8"));
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(`${base}/r/${id}`)).text();
    const config = JSON.parse(page.match(/window.__PR_REVIEW__=(\{.*?\})<\/script>/)[1]);
    if (!page.includes("<title>feat/books · library</title>")) fail("the review page does not carry the branch · repo title");
    if (page.length > 20_000) fail(`the review page is ${page.length} bytes; it should load the app and its data, not carry them`);
    await checkAppAssets(base, page);
    // A failing command prints its reason and exits 1. Before, the error threw out of main() after a fetch, which aborted Node
    // on Windows and printed a stack trace everywhere else.
    try {
      review("open", "--report", join(reviewDir, "missing.json"));
      fail("review.mjs open with a missing report did not fail");
    } catch (e) {
      const err = String(e.stderr ?? "");
      if (e.status !== 1 || !err.includes("report file not found") || err.includes("Assertion failed") || err.includes("    at ")) fail(`a failing review.mjs command did not end cleanly (exit ${e.status}):\n${err}`);
    }
    const post = (path, body) =>
      fetch(`${base}${config.api}/${path}`, { method: "POST", headers: { "x-review-token": config.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const state = async () => {
      const res = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.cancel();
      return JSON.parse(new TextDecoder().decode(value).match(/data: (.*)/)[1]);
    };
    // The start of the stream as text, for the events around the states.
    const streamStart = async () => {
      const res = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body.getReader();
      let text = "";
      for (let i = 0; i < 3 && !text.includes("event: daemon"); i++) text += new TextDecoder().decode((await reader.read()).value);
      reader.cancel();
      return text;
    };

    // Who is reading: the page token is required, and without a gh login the answer is the repo's git identity.
    const meUrl = `${base}/api/me?${new URLSearchParams({ host: "github.com", forge: "github", root: repo })}`;
    if ((await fetch(meUrl)).status !== 401) fail("the identity endpoint answers without the page token");
    const me = await (await fetch(meUrl, { headers: { "x-review-token": config.token } })).json();
    if (me.source !== "git" || me.name !== "Sample Dev" || me.avatar?.initials !== "SD") fail(`the identity did not fall back to the repo's git config: ${JSON.stringify(me)}`);
    // The stream introduces the daemon (version, uptime) after the review states, so a first-chunk reader still gets a state first.
    const hello = await streamStart();
    const daemonAt = hello.indexOf("event: daemon");
    if (daemonAt < 0 || daemonAt < hello.indexOf("event: state") || !hello.includes('"startedAt"')) fail("the event stream does not introduce the daemon after the review states");
    // Purging the cache from the page removes what is under cache/ and nothing else.
    mkdirSync(join(env.PR_REPORT_HOME, "cache", "avatars"), { recursive: true });
    writeFileSync(join(env.PR_REPORT_HOME, "cache", "avatars", "stale"), "x");
    const purged = await (await fetch(`${base}/api/cache/purge`, { method: "POST", headers: { "x-review-token": config.token } })).json();
    if (!(purged.removed >= 1) || existsSync(join(env.PR_REPORT_HOME, "cache")) || !existsSync(join(env.PR_REPORT_HOME, "daemon.json"))) fail("purging the cache did not remove exactly the cache folder");
    // The settings the agent reads: behind the page token, off until changed, and saved to the file the scripts read.
    const settingsUrl = `${base}/api/settings`;
    const asPage = { "x-review-token": config.token, "content-type": "application/json" };
    if ((await fetch(settingsUrl)).status !== 401) fail("the settings endpoint answers without the page token");
    const settingsBefore = await (await fetch(settingsUrl, { headers: asPage })).json();
    const settingsAfter = await (await fetch(settingsUrl, { method: "POST", headers: asPage, body: JSON.stringify({ subagents: true, other: "x" }) })).json();
    const settingsOnDisk = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "settings.json"), "utf8"));
    if (settingsBefore.subagents !== false || settingsAfter.subagents !== true || settingsOnDisk.subagents !== true || "other" in settingsOnDisk)
      fail(`the settings were not saved as sent: ${JSON.stringify({ settingsBefore, settingsAfter, settingsOnDisk })}`);
    if ((await fetch(settingsUrl, { method: "POST", headers: asPage, body: "{" })).status !== 400) fail("the settings endpoint takes a body that is not JSON");
    // A value of the wrong type in the file counts as not set.
    writeFileSync(join(env.PR_REPORT_HOME, "settings.json"), JSON.stringify({ subagents: "yes" }));
    if ((await (await fetch(settingsUrl, { headers: asPage })).json()).subagents !== false) fail("a setting of the wrong type in settings.json is taken for on");

    // The page is told which agent it talks to: in its config, and live from whoever called last.
    if (config.agent?.name !== "Claude" || (await state()).agent?.product !== "Claude Code") fail(`the page does not know the agent that opened the review: ${JSON.stringify(config.agent)}`);
    review("resume", "--id", id, "--agent", "codex");
    if ((await state()).agent?.name !== "Codex") fail("a call from another agent did not change the agent the page shows");
    // A call that names nobody, such as one typed in a plain terminal, leaves the agent as it was.
    run("node", [join(root, "skill/scripts/review.mjs"), "resume", "--id", id], { ...env, PR_REPORT_AGENT: "", AI_AGENT: "", CLAUDECODE: "" });
    if ((await state()).agent?.name !== "Codex") fail("a call that names no agent cleared the one the page shows");
    review("resume", "--id", id);
    if ((await state()).agent?.name !== "Claude") fail("the agent did not change back with the next call");

    // The inbox reloads on state events; the first one on connect must match what it shows, or it reloads forever.
    const inbox = await (await fetch(`${base}/`)).text();
    const shown = JSON.parse(inbox.match(/const shown=(\{.*?\});/)?.[1] ?? "{}");
    if (shown[id] !== (await state()).updatedAt) fail("the inbox would reload on the stream's first state event (reload loop)");
    if ((await state()).listening) fail("a review with no waiter counts as listened to");
    if (!/<span class="av" style="background:#[0-9a-f]{6}">AL<\/span>/.test(inbox)) fail("the inbox does not show the owner's initials");
    if (!inbox.includes("<title>(1) Reflektor</title>")) fail("the inbox title does not count the review waiting on you");
    if (!inbox.includes('data-owner="acme-labs"')) fail("the inbox rows do not carry the owner they are grouped by");
    if (!/<span class="tag" style="background:#[0-9a-f]{6}"><svg /.test(inbox)) fail("the inbox tag has no color or icon");
    if (!inbox.includes('name="q"') || !(await (await fetch(`${base}/fuse.mjs`)).text()).includes("Fuse.js")) fail("the inbox search or its Fuse.js file is missing");

    const round1 = await (await fetch(`${base}${config.api}/bundle?round=1`, { headers: { "x-review-token": config.token } })).json();
    if (!round1?.report?.title) fail("the daemon did not return round 1's report data as an object");
    await post("presence", { tab: "t1" });
    // The agent rebuilds round 1 (for example after the checks end) and publishes it again.
    build(join(reviewDir, "round1.json"));
    const again = review("open", "--report", join(reviewDir, "round1.json"));
    if (!again.includes("Open in 1 tab")) fail("an open tab was not counted");
    if (!again.includes("already published")) fail("publishing round 1 again did not say it was already published");
    const rebuiltAt = JSON.parse(readFileSync(join(reviewDir, "round1.json"), "utf8")).builtAt;
    if ((await state()).roundBuiltAt !== rebuiltAt) fail("open pages are not told that round 1 was published again");

    // Code edited after the build: the page is told, and the reviewer can ask the agent for an update.
    const edited = join(repo, "apps/web/src/api/books.ts");
    const original = readFileSync(edited, "utf8");
    writeFileSync(edited, `${original}// edited after the report\n`);
    await post("presence", { tab: "t1" });
    const driftIs = async (test) => {
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
    const pollsUntil = async (test, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        if (test()) return true;
        await sleep(200);
      }
      return false;
    };
    const prIs = async (test) => {
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
    // The agent opened a pull request: review.mjs pr shows it at once, from the URL gh printed.
    github.know(githubPr(8, "open"));
    github.set([githubPr(8, "open"), githubPr(7, "closed")]);
    const told = await reviewAsync("pr", "--id", id, "--url", "https://github.com/acme-labs/library/pull/8");
    if (!told.includes("pull request #8 (open)")) fail(`review.mjs pr did not confirm the pull request:\n${told}`);
    if ((await state()).pr?.number !== 8) fail("review.mjs pr did not put the pull request into the page state");
    if (!github.requests.some((q) => q.path === "/repos/acme-labs/library/pulls/8")) fail("the daemon did not read the pull request the agent named");
    // Merged on GitHub: the page and the inbox say so, and the daemon stops asking.
    github.set([githubPr(8, "closed", "2026-11-09T12:00:00Z")]);
    if (!(await prIs((p) => p?.state === "MERGED" && p.mergedAt === "2026-11-09T12:00:00Z"))) fail("a merge on GitHub did not reach the page state");
    const mergedInbox = await (await fetch(`${base}/`)).text();
    if (!mergedInbox.includes('data-phase="merged"') || !mergedInbox.includes(">Merged</span>") || !mergedInbox.includes('data-state="MERGED"')) fail("the inbox does not show the merged review as merged");
    if (!mergedInbox.includes("<title>Reflektor</title>")) fail("a merged review still counts as waiting on you in the inbox title");
    const mergedAt = polls().length;
    await sleep(1500);
    if (polls().length !== mergedAt) fail("the daemon kept polling GitHub after the pull request was merged");
    if (JSON.parse(readFileSync(join(reviewDir, "review-state.json"), "utf8")).pr?.state !== "MERGED") fail("the pull request is not saved with the review's state");

    // Project checks stream into the page as they run, finish or crash.
    const until = async (test) => {
      for (let i = 0; i < 40; i++) {
        const s = await state();
        if (test(s.checks)) return s.checks;
        await sleep(200);
      }
      return null;
    };
    const checksScript = join(root, "skill/scripts/checks.mjs");
    if ((await state()).checks?.results.length !== 3) fail("the page state does not carry the project checks");
    spawn("node", [checksScript, "--repo", repo, "--run", "quick=sleep 1"], { stdio: "ignore" });
    if (!(await until((c) => c?.status === "running" && c.pending.join() === "quick"))) fail("a running check did not reach the page state");
    if (!(await until((c) => c?.status === "done" && c.results[0]?.status === "passed"))) fail("a finished check did not reach the page state");
    spawn("node", [checksScript, "--repo", repo, "--run", "hang=sleep 3"], { stdio: "ignore" });
    await until((c) => c?.status === "running");
    process.kill(JSON.parse(readFileSync(join(repo, ".git/pr-report/feat-books/checks.json"), "utf8")).pid, "SIGKILL");
    if (!(await until((c) => c?.status === "stopped" && c.pending.join() === "hang"))) fail("a crashed check run was not shown as stopped");

    await post("questions", { id: "q_1", target: { type: "report" }, text: "Why two migrations?" });
    if (!(await state()).undeliveredSince) fail("a question nobody picked up is not shown as waiting");
    if (!review("wait", "--id", id).includes("Live question q_1")) fail("wait did not return the live question");
    review("answer", "--id", id, "--question", "q_1", "--text", "One per change.");
    if (!(await state()).questions[0]?.answer) fail("the answer did not reach the page state");

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
    const waiter = spawn("node", [join(root, "skill/scripts/review.mjs"), "wait", "--id", id], { env: { ...process.env, ...env } });
    let waited = "";
    waiter.stdout.on("data", (d) => (waited += d));
    const waiterExit = new Promise((resolveExit) => waiter.on("exit", resolveExit));
    await sleep(500);
    if (!(await state()).listening) fail("a running waiter does not count as listening");
    const daemonPid = () => JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8")).pid;
    const oldPid = daemonPid();
    const goodbye = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`);
    const goodbyeReader = goodbye.body.getReader();
    review("stop");
    // The daemon tells open pages it is going away, so they can show "restarting" rather than "unavailable".
    let heard = "";
    for (let i = 0; i < 5 && !heard.includes("event: shutdown"); i++) {
      const chunk = await Promise.race([goodbyeReader.read(), sleep(1000).then(() => ({ done: true }))]).catch(() => ({ done: true }));
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
    if (!archivedInbox.includes("Archived (1)") || !archivedInbox.includes("<title>Reflektor</title>")) fail("an archived review did not move to the archived list");
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
  const collect = (...a) => run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch", "--out", join(dir, "diff.json"), ...a]);
  const build = (out) => run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(dir, "diff.json"), "--report", join(dir, "report.json"), "--out", join(dir, out)]);
  const readReport = () => JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const service = (r) => r.sections.find((s) => s.kind === "backend");

  collect();
  writeFileSync(join(dir, "report.json"), readFileSync(join(root, "samples/report.json")));
  build("r1.json");
  const round1 = JSON.parse(readFileSync(join(dir, "r1.json"), "utf8"));
  writeFileSync(join(dir, "review-1.json"), JSON.stringify({ version: 1, round: 1, branch: "feat/books", headSha: round1.diff.branch.headSha, snapshot: round1.diff.branch.snapshot, comments: [] }));
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
  const notes = service(carried).files.find((f) => f.path.endsWith("book.service.ts")).lineNotes.map((n) => n.line);
  if (notes.join() !== "8,21") fail(`line notes were not moved with their lines: ${notes.join()}`);
  if (!carried.refsAt) fail("the carried report does not record which code its references point into");

  if (!collect("--update").includes("0 line references moved")) fail("collecting the next round twice moved the references twice");
  if (service(readReport()).files.find((f) => f.path.endsWith("book.service.ts")).lineNotes[0].line !== 8) fail("a second collect changed the moved references");

  build("r2.json");
  const round2 = JSON.parse(readFileSync(join(dir, "r2.json"), "utf8"));
  if (round2.round !== 2 || round2.diff.files.length !== round1.diff.files.length) fail("round 2 does not show the whole branch");
  if (round2.diff.sinceRound?.round !== 1 || round2.diff.sinceRound.files.map((f) => f.path).join() !== "apps/api/src/books/book.service.ts") fail("round 2 does not carry the change since round 1");
  if (!round2.prDescription || readFileSync(join(dir, "pr-description.md"), "utf8") === description) fail("a whole-branch round did not rewrite the PR description");

  // A report about part of the branch leaves the PR description alone.
  const whole = readFileSync(join(dir, "pr-description.md"), "utf8");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n// three\n`);
  collect("--since", "last");
  const partial = build("r3.json");
  if (JSON.parse(readFileSync(join(dir, "r3.json"), "utf8")).prDescription !== null) fail("a --since report carried a PR description");
  if (readFileSync(join(dir, "pr-description.md"), "utf8") !== whole || !partial.includes("PR description not updated")) fail("a --since report overwrote the PR description");
  // Another branch in the same checkout gets its own report folder, so their rounds stay apart.
  run("git", ["-C", repo, "checkout", "-q", "-b", "feat/other"]);
  const other = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"]);
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
    const child = spawn("node", [join(root, "skill/scripts/daemon.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.output = "";
    child.stdout.on("data", (d) => (child.output += d));
    child.stderr.on("data", (d) => (child.output += d));
    return child;
  });
  for (let i = 0; i < 60 && daemons.filter((d) => d.exitCode === null).length > 1; i++) await sleep(100);
  await sleep(500);
  const running = daemons.filter((d) => d.exitCode === null);
  const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  if (running.length !== 1 || running[0].pid !== info.pid) fail(`${running.length} daemons kept running after 6 started at once:\n${daemons.map((d) => d.output).join("")}`);
  const crashed = daemons.find((d) => /Error|Assertion/.test(d.output));
  if (crashed) fail(`a daemon crashed when 6 started at once:\n${crashed.output}`);
  for (const d of running) d.kill();
  await sleep(200);
  console.log("concurrent start: one daemon out of 6 started at once, past an old empty lock");
}

if (failed) process.exitCode = 1;
else console.log(`check passed: ${html}`);

if (!failed && process.argv.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [html], { detached: true, stdio: "ignore" }).unref();
}
