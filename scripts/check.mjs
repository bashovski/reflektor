#!/usr/bin/env node
// End-to-end check: rebuilds the fake books repo, runs collect.mjs and build.mjs on it with
// samples/report.json, and fails on any warning. Then drives a whole review through a private daemon.
// Also refreshes samples/bundle.json for `pnpm dev` and the standalone samples/books-report.html.
//
// Usage: node scripts/check.mjs [--open]

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-check-"));
const repo = join(tmp, "books");
const html = join(root, "samples", "books-report.html");

const run = (cmd, args, env) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });

let failed = false;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failed = true;
};

try {
  run("bash", [join(root, "fixtures", "make-books-repo.sh"), repo]);

  const collected = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"]);
  if (!collected.includes("Patch coverage: 51%")) fail("collect.mjs did not read coverage from .pr-report.json");
  if (!collected.includes("(config)")) fail("collect.mjs did not take the base branch from .pr-report.json");
  if (!collected.includes("Safety checks: 1 high, 0 medium, 1 low")) fail("collect.mjs safety checks did not find the slug migration problems");

  // Edge cases in a second repo. The key-shaped value is built at runtime, so no literal secret is stored here.
  const edgeRepo = join(tmp, "edge");
  run("bash", ["-c", `mkdir -p "${edgeRepo}/gen" && cd "${edgeRepo}" && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base && git checkout -qb feat`]);
  writeFileSync(join(edgeRepo, "config.js"), `export const key = "${"AKIA" + "Q".repeat(16)}";\n`);
  writeFileSync(join(edgeRepo, ".gitattributes"), "gen/*.js linguist-generated\n");
  writeFileSync(join(edgeRepo, "gen", "api.js"), "export const api = 1;\n");
  writeFileSync(join(edgeRepo, "big.txt"), "x".repeat(600 * 1024));
  writeFileSync(join(edgeRepo, "naïve name.ts"), "export const ok = true;\n");
  const edgeOut = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", edgeRepo, "--no-fetch", "--base", "main", "--out", join(tmp, "edge.json")]);
  if (!edgeOut.includes("AWS access key [AKIA…(20 characters)]")) fail("collect.mjs did not flag or mask a fake AWS key");
  const edge = Object.fromEntries(JSON.parse(readFileSync(join(tmp, "edge.json"), "utf8")).files.map((f) => [f.path, f]));
  if (!edge["gen/api.js"]?.generated) fail("collect.mjs did not mark a linguist-generated file as generated");
  if (!edge["big.txt"]?.tooLarge || edge["big.txt"].newContent !== null) fail("collect.mjs did not leave out a file over the size limit");
  if (edge["naïve name.ts"]?.newContent !== "export const ok = true;\n") fail("collect.mjs did not read a file with a space and accent in its name");

  const checked = run("node", [
    join(root, "skill/scripts/checks.mjs"), "--repo", repo,
    "--run", "whitespace=git diff --check HEAD",
    "--run", `typecheck=node -e "console.error('apps/api/src/books/book.service.ts(1,18): error TS7016: Could not find a declaration file for module isbn3.'); process.exit(2)"`,
    "--run", `tests=node -e "console.log('3 passed')"`,
  ]);
  if (!checked.includes("Project checks: 2 passed, 1 failed")) fail("checks.mjs did not report 2 passed and 1 failed");

  const built = run("node", [
    join(root, "skill/scripts/build.mjs"),
    "--diff", join(repo, ".git/pr-report/diff.json"),
    "--report", join(root, "samples/report.json"),
    "--out", join(root, "samples/bundle.json"),
    "--html", html,
  ]);
  for (const line of built.split("\n").filter((l) => l.startsWith("warning:"))) fail(line);

  const bundle = JSON.parse(readFileSync(join(root, "samples/bundle.json"), "utf8"));
  const missingIcons = bundle.diff.files.filter((f) => !bundle.fileIcons?.byPath[f.path]);
  if (missingIcons.length) fail(`no file icon for ${missingIcons.length} files (run node scripts/build-icons.mjs)`);

  const page = readFileSync(html, "utf8");
  if (page.includes("__PR_REPORT_DATA__")) fail("report data was not injected into the viewer");
  if (statSync(html).size < 1_000_000) fail("the standalone page is too small; build.mjs probably used the unbuilt viewer");

  await daemonFlow();
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

async function daemonFlow() {
  const env = { PR_REPORT_HOME: join(tmp, "home"), PR_REPORT_PORT: String(4400 + Math.floor(Math.random() * 500)) };
  const reviewDir = join(tmp, "review");
  const review = (...args) => run("node", [join(root, "skill/scripts/review.mjs"), ...args], env);
  const build = (out) =>
    run("node", [join(root, "skill/scripts/build.mjs"), "--diff", join(repo, ".git/pr-report/diff.json"), "--report", join(root, "samples/report.json"), "--out", out]);
  try {
    build(join(reviewDir, "round1.json"));
    const opened = review("open", "--report", join(reviewDir, "round1.json"));
    const id = opened.match(/Review id: (\S+)/)?.[1];
    if (!id) return fail(`review.mjs open printed no id:\n${opened}`);

    const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8"));
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(`${base}/r/${id}`)).text();
    const config = JSON.parse(page.match(/window.__PR_REVIEW__=(\{.*?\})<\/script>/)[1]);
    if (page.length > 20_000) fail(`the review page is ${page.length} bytes; it should load the app and its data, not carry them`);
    await checkAppAssets(base, page);
    const post = (path, body) =>
      fetch(`${base}${config.api}/${path}`, { method: "POST", headers: { "x-review-token": config.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const state = async () => {
      const res = await fetch(`${base}/api/events?token=${config.token}&watch=${id}`, { signal: AbortSignal.timeout(2000) });
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.cancel();
      return JSON.parse(new TextDecoder().decode(value).match(/data: (.*)/)[1]);
    };

    const round1 = await (await fetch(`${base}${config.api}/bundle?round=1`, { headers: { "x-review-token": config.token } })).json();
    if (!round1?.report?.title) fail("the daemon did not return round 1's report data as an object");
    await post("presence", { tab: "t1" });
    if (!review("open", "--report", join(reviewDir, "round1.json")).includes("Already open in 1 tab")) fail("an open tab was not counted");

    await post("questions", { id: "q_1", target: { type: "report" }, text: "Why two migrations?" });
    if (!review("wait", "--id", id).includes("Live question q_1")) fail("wait did not return the live question");
    review("answer", "--id", id, "--question", "q_1", "--text", "One per change.");
    if (!(await state()).questions[0]?.answer) fail("the answer did not reach the page state");

    const comment = { id: "c_1", target: { type: "report" }, text: "Rename slug to handle", createdAt: new Date().toISOString() };
    await post("submit", { comments: [comment] });
    if (!review("wait", "--id", id).includes("was sent with 1 comments")) fail("wait did not report the sent review");

    writeFileSync(join(tmp, "plan.json"), JSON.stringify({ steps: [{ comments: ["c_1"], where: "0043_add_author_slug.sql", kind: "fix", action: "Rename the column" }] }));
    review("plan", "--id", id, "--file", join(tmp, "plan.json"));
    if ((await state()).phase !== "planning") fail("posting a plan did not move the review to planning");
    await post("plan-decision", { decision: "approve", kinds: {} });
    if (!review("wait", "--id", id).includes("approved the plan")) fail("wait did not report the approved plan");

    review("status", "--id", id, "--comment", "c_1", "--status", "fixed", "--text", "Renamed");
    if ((await state()).statuses.c_1?.status !== "fixed") fail("the status did not reach the page state");

    build(join(reviewDir, "round2.json"));
    if (!review("open", "--report", join(reviewDir, "round2.json")).includes("round 2")) fail("publishing the next build did not start round 2");
    const round2 = await state();
    if (round2.round !== 2 || round2.phase !== "reviewing") fail(`round 2 is not open for review: ${JSON.stringify({ round: round2.round, phase: round2.phase })}`);

    await post("submit", { comments: [] });
    if (!review("wait", "--id", id).includes("The review is done")) fail("an empty review did not end the review");
    console.log("daemon flow: question, sent review, plan, status, round 2 and finish all worked");
  } finally {
    try {
      review("stop");
    } catch {
      // Already stopped.
    }
  }
}

if (failed) process.exit(1);
console.log(`check passed: ${html}`);

if (process.argv.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [html], { detached: true, stdio: "ignore" }).unref();
}
