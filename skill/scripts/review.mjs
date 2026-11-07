#!/usr/bin/env node
// The agent's side of a review. Talks to the pr-report daemon and starts it when needed.
//
//   open    --report <json> [--open]     publish a report (a new review, or the next round of one)
//   wait    --id <review>                block until the reviewer does something; run in the background
//   answer  --id <review> --question <id> (--text <t> | --text-file <f>) [--ref path:line]
//   plan    --id <review> --file <plan.json>
//   status  --id <review> --comment <id> --status working|fixed|answered|wontfix|noted [--text <t>] [--ref path:line]
//   resume  [--id <review>] [--repo .]   pick up a review in a new session: what is waiting, and what to do
//   list                                  every review the daemon knows
//   stop                                  stop the daemon

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const daemonScript = join(here, "daemon.mjs");
const daemonFile = join(HOME, "daemon.json");
const expectedVersion = createHash("sha1").update(readFileSync(daemonScript)).digest("hex").slice(0, 12);

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, "");
  if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) args[key] = true;
  else args[key] = rest[++i];
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseRef = (value) => {
  if (!value || value === true) return undefined;
  const [path, line] = String(value).split(":");
  return { path, line: line ? Number(line) : undefined };
};
const textArg = () => (args["text-file"] ? readFileSync(args["text-file"], "utf8") : typeof args.text === "string" ? args.text : null);

async function health(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-admin-token": info.adminToken }, signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ensureDaemon() {
  let info = readJson(daemonFile);
  let status = info && (await health(info));
  if (status && status.version !== expectedVersion) {
    // The skill was updated: replace the running daemon with the new code.
    await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: "POST", headers: { "x-admin-token": info.adminToken } }).catch(() => {});
    for (let i = 0; i < 30 && (await health(info)); i++) await sleep(100);
    status = null;
  }
  if (status) return info;

  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "daemon.log"), "a");
  spawn(process.execPath, [daemonScript], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    info = readJson(daemonFile);
    if (info && info.version === expectedVersion && (await health(info))) return info;
  }
  throw new Error(`The daemon did not start. See ${join(HOME, "daemon.log")}`);
}

async function api(info, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { "x-admin-token": info.adminToken, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 204) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return { status: res.status, data };
}

const need = (...keys) => {
  const missing = keys.filter((k) => !args[k] || args[k] === true);
  if (missing.length) {
    console.log(`${command} needs ${missing.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
};

const describe = (t) => {
  switch (t.type) {
    case "line":
      return `${t.path} ${t.start === t.end ? `line ${t.start}` : `lines ${t.start}-${t.end}`} (${t.side === "old" && t.round ? `the version round ${t.round} showed` : `${t.side} version`})`;
    case "file":
      return t.path;
    case "report":
      return "the whole change";
    default:
      return `${t.type}: ${t.text ?? ""}`;
  }
};

const self = `node ${join(here, "review.mjs")}`;

// What the reviewer did, and what the agent runs next. Printed by wait and resume.
function explain(event, review) {
  if (event.type === "question") {
    const q = event.question;
    console.log(`Live question ${q.id} in review ${review.id}`);
    console.log(`About: ${describe(q.target)}`);
    if (q.target.type === "line") console.log(["```", q.target.code, "```"].join("\n"));
    if (q.target.fix) console.log(`Suggested fix shown with it: ${q.target.fix}`);
    console.log(`Question: ${q.text}`);
    console.log(`\nAnswer: ${self} answer --id ${review.id} --question ${q.id} --text "<answer>"`);
    console.log("Then run wait again in the background.");
  } else if (event.type === "review-submitted" && event.count === 0) {
    console.log(`The reviewer finished round ${event.round} of ${review.id} with no comments. The review is done.`);
    console.log("Offer to open the PR (ask first).");
  } else if (event.type === "review-submitted") {
    console.log(`Review for round ${event.round} of ${review.id} was sent with ${event.count} comments: ${event.file}`);
    console.log(`\nNext: read the file, then post your plan: ${self} plan --id ${review.id} --file <plan.json>`);
    console.log("Then run wait again in the background for the reviewer's decision.");
  } else if (event.type === "plan-decision" && event.decision.decision === "approve") {
    const kinds = Object.entries(event.decision.kinds ?? {});
    console.log(`The reviewer approved the plan for ${review.id}.`);
    if (kinds.length) console.log(`Kind changes by step: ${kinds.map(([step, kind]) => `step ${Number(step) + 1} -> ${kind}`).join(", ")}`);
    if (event.decision.note) console.log(`Note: ${event.decision.note}`);
    console.log(`\nNext: make the changes. Report each comment as you go: ${self} status --id ${review.id} --comment <id> --status working|fixed|answered|wontfix|noted --text "<short>"`);
    console.log(`Then collect --next-round, update the carried report.json and add review.replies, build, and publish: ${self} open --report <new json>`);
  } else if (event.type === "round-finished") {
    console.log(`Round ${event.round} of ${review.id} is finished: all ${event.count} comments are handled and no code changed. The review is done.`);
    console.log("Offer to open the PR (ask first).");
  } else if (event.type === "plan-decision") {
    console.log(`The reviewer wants a different plan for ${review.id}.`);
    if (event.decision.note) console.log(`Note: ${event.decision.note}`);
    console.log(`\nNext: post a new plan with ${self} plan, then run wait again in the background.`);
  } else {
    console.log(JSON.stringify(event, null, 2));
  }
}

// ------------------------------------------------------------------ commands

if (command === "open") {
  need("report");
  const info = await ensureDaemon();
  const { data } = await api(info, "POST", "/api/reviews", { report: resolve(args.report) });
  console.log(`Review: ${data.url}`);
  console.log(`Review id: ${data.id} (round ${data.round})`);
  if (data.republished) console.log(`Round ${data.round} was already published. It now uses this build; comments, plan and progress are kept.`);
  if (args.open && data.tabs === 0) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [data.url], { detached: true, stdio: "ignore" }).unref();
    console.log("Opened it in the browser.");
  } else if (data.tabs > 0) {
    console.log(
      data.republished
        ? `Open in ${data.tabs} tab(s); a reload shows this build.`
        : `Already open in ${data.tabs} tab(s); they show a banner for the new round.`,
    );
  }
  console.log(`Next: run in the background: ${self} wait --id ${data.id}`);
} else if (command === "wait") {
  need("id");
  let info = await ensureDaemon();
  for (let failures = 0; ; ) {
    let result;
    try {
      result = await api(info, "GET", `/api/r/${encodeURIComponent(args.id)}/next-event`);
      failures = 0;
    } catch (e) {
      // The daemon restarts when the skill is updated. Start it again and keep waiting.
      if (++failures > 3) {
        console.log(`The review daemon is not reachable (${e.message}). Run wait again in the background.`);
        process.exit(0);
      }
      await sleep(1000);
      info = await ensureDaemon().catch(() => info);
      continue;
    }
    if (result.status === 204) continue;
    explain(result.data.event, result.data.review);
    process.exit(0);
  }
} else if (command === "resume") {
  const info = await ensureDaemon();
  let id = typeof args.id === "string" ? args.id : null;
  if (!id) {
    // This branch's review: the newest one whose files are in this repo's git folder.
    const git = (...a) => execFileSync("git", a, { cwd: resolve(typeof args.repo === "string" ? args.repo : "."), encoding: "utf8" }).trim();
    const gitDir = resolve(git("rev-parse", "--show-toplevel"), git("rev-parse", "--git-dir"));
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    const { data } = await api(info, "GET", "/api/reviews");
    const mine = data.reviews.filter((r) => r.branch === branch && (r.dir === join(gitDir, "pr-report") || r.dir.startsWith(gitDir)));
    id = mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
    if (!id) {
      console.log(`No review of ${branch} is open. Run /pr-report to start one.`);
      process.exit(0);
    }
  }
  const { data } = await api(info, "GET", `/api/r/${encodeURIComponent(id)}/resume`);
  const { event, review } = data;
  console.log(`Picking up review ${review.id}, round ${review.round}: http://127.0.0.1:${info.port}/r/${review.id}\n`);
  if (event) explain(event, review);
  else if (review.phase === "working" && review.open.length) {
    console.log(`The fix loop for round ${review.round} was cut off: ${review.comments - review.open.length} of ${review.comments} comments are handled. Review file: ${review.file}`);
    console.log("Still open:");
    for (const c of review.open) console.log(`  ${c.id} (${c.kind ?? "no kind"}): ${c.text.split("\n")[0].slice(0, 120) || "(no text)"}`);
    console.log(`\nNext: read the review file and the plan (the page shows it), finish these comments with ${self} status, then rebuild and publish the next round.`);
  } else if (review.phase === "working") {
    console.log(`Every comment in round ${review.round} has a status. Next: rebuild and publish the next round with ${self} open --report <new json>.`);
  } else if (review.phase === "done") {
    console.log("The review is done. Offer to open the PR (ask first).");
  } else {
    const waitingOn = review.phase === "planning" ? "the reviewer's decision on your plan" : "the reviewer";
    console.log(`Nothing is waiting for you: round ${review.round} waits on ${waitingOn}.`);
    console.log(`\nNext: run in the background: ${self} wait --id ${review.id}`);
  }
} else if (command === "answer") {
  need("id", "question");
  const text = textArg();
  if (!text) need("text");
  const info = await ensureDaemon();
  await api(info, "POST", `/api/r/${encodeURIComponent(args.id)}/answers`, { questionId: args.question, text, ref: parseRef(args.ref) });
  console.log(`Answered ${args.question}. The page shows it right away.`);
} else if (command === "plan") {
  need("id", "file");
  const plan = JSON.parse(readFileSync(args.file, "utf8"));
  const info = await ensureDaemon();
  await api(info, "POST", `/api/r/${encodeURIComponent(args.id)}/plan`, plan);
  console.log(`Plan posted with ${plan.steps.length} steps. The reviewer can approve it in the page or in the chat.`);
} else if (command === "status") {
  need("id", "comment", "status");
  const info = await ensureDaemon();
  const { data } = await api(info, "POST", `/api/r/${encodeURIComponent(args.id)}/status`, {
    commentId: args.comment,
    status: args.status,
    text: textArg(),
    ref: parseRef(args.ref),
  });
  console.log(`${args.comment}: ${args.status}`);
  if (data?.finished) {
    console.log(`\nEvery comment is handled and none changed code, so round ${data.round} is finished. The page shows the review as done.`);
    console.log("Skip the rebuild. Tell the user, and offer to open the PR (ask first).");
  }
} else if (command === "list") {
  const info = await ensureDaemon();
  const { data } = await api(info, "GET", "/api/reviews");
  if (!data.reviews.length) console.log("No reviews yet.");
  for (const r of data.reviews) console.log(`${r.id.padEnd(36)} round ${String(r.round).padEnd(3)} ${r.phase.padEnd(10)} ${r.url}`);
  console.log(`\nInbox: http://127.0.0.1:${info.port}/`);
} else if (command === "stop") {
  const info = readJson(daemonFile);
  if (!info || !existsSync(daemonFile)) console.log("The daemon is not running.");
  else {
    await api(info, "POST", "/api/shutdown").catch(() => {});
    console.log("Stopped the daemon.");
  }
} else {
  console.log("Usage: review.mjs open|wait|resume|answer|plan|status|list|stop (see the top of this file)");
  process.exit(2);
}
