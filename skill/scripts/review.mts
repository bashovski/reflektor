#!/usr/bin/env node
// The agent's side of a review. Talks to the pr-report daemon and starts it when needed.
//
//   open    --report <json> [--open]     publish a report (a new review, or the next round of one)
//   wait    --id <review>                block until the reviewer does something; run in the background
//   answer  --id <review> --question <id> (--text <t> | --text-file <f>) [--ref path:line]
//   plan    --id <review> --file <plan.json>
//   status  --id <review> --comment <id> --status working|fixed|answered|wontfix|noted [--text <t>] [--ref path:line]
//   pr      --id <review> --url <pull request url> [--title <t>]   show the pull request you just opened; the page follows it from there
//   resume  [--id <review>] [--repo .]   pick up a review in a new session: what is waiting, and what to do
//   list                                  every review the daemon knows
//   setup   [--no-open]                   open the first-run setup page (tools, light or dark, code theme)
//   stop                                  stop the daemon
//
// Every command tells the daemon which agent is calling, worked out from the shell it runs in (agent.mts).
// --agent <id> says it outright; --agent-name "<product>" is the agent's own answer when nothing else is known.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommentTarget, LiveQuestion, PrState, ReviewComment } from "../schema/types.ts";
import { AGENT_HEADER, detectAgent, encodeAgent } from "./agent.mts";
import { runReportHooks } from "./hooks.mts";
import { shellPath } from "./repo.mts";

// daemon.json, which the daemon writes when it starts: where it listens and its admin token.
type DaemonInfo = { port: number; pid: number; version: string; adminToken: string; startedAt: string };
// What GET /api/health answers.
type Health = { ok: boolean; version: string; pid: number };
// A review's phase in the daemon.
type Phase = "reviewing" | "sent" | "planning" | "working" | "done";
// A pull request as the daemon follows it (prFrom in daemon.mts).
type FollowedPr = { number: number; url: string; title: string | null; state: PrState; base: string | null; mergedAt: string | null; checkedAt: string };
// The reviewer's decision on the agent's plan. `kinds` maps a step's index to the kind the reviewer chose for it.
type PlanDecision = { decision: "approve" | "changes"; note: string | null; kinds: Record<string, string>; at: string };
// What the reviewer did, as the daemon queues it (pushEvent in daemon.mts). A question's target is read for `fix`, which only some targets have.
type ReviewEvent =
  | { type: "question"; questionId: string; question: LiveQuestion & { target: { fix?: string } } }
  | { type: "review-submitted"; round: number; file: string; count: number }
  | { type: "plan-decision"; decision: PlanDecision }
  | { type: "round-finished"; round: number; count: number }
  | { type: "refresh"; round: number; files: string[]; commits: number };
// The review an event belongs to, as next-event sends it.
type EventReview = { id: string; round: number; dir: string };
// What GET /api/r/<id>/next-event answers when the reviewer did something.
type NextEvent = { event: ReviewEvent; review: EventReview };
// What GET /api/r/<id>/resume answers: the event a lost session never handled, if any, and where the round stands.
type Resumed = { event: ReviewEvent | null; review: EventReview & { phase: Phase; file: string; comments: number; open: ReviewComment[] } };
// What GET /api/reviews answers: liveState in daemon.mts with each review's folder and page URL, only the fields read here.
type ReviewList = { reviews: { id: string; branch: string; dir: string; round: number; phase: Phase; updatedAt: string; url: string; pr: FollowedPr | null }[] };
// What POST /api/reviews answers: the round just published.
type Published = { id: string; round: number; republished: boolean; firstReal: boolean; url: string; tabs: number; dir: string };
// What POST /api/r/<id>/status answers: whether that status finished the round.
type StatusSet = { ok: true; finished: boolean; round: number };
// What POST /api/r/<id>/pr answers: the pull request the page follows now.
type PrSet = { pr: FollowedPr };
// The plan file the agent wrote; only its steps are counted here.
type PlanFile = { steps: unknown[] };

const here = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const daemonScript = join(here, "daemon.mts");
const daemonFile = join(HOME, "daemon.json");
// Read from disk each time: a waiter that started before the skill was updated must take the new
// daemon as current, not shut it down as out of date.
const expectedVersion = () => createHash("sha1").update(readFileSync(daemonScript)).digest("hex").slice(0, 12);

const [command, ...rest] = process.argv.slice(2);
const args: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, "");
  if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) args[key] = true;
  else args[key] = rest[++i];
}

// Who is calling. Worked out here, in the agent's own shell, and sent with every request: the daemon serves
// every agent on the machine and cannot know by itself.
const agent = detectAgent({ id: typeof args.agent === "string" ? args.agent : undefined, name: typeof args["agent-name"] === "string" ? args["agent-name"] : undefined });

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseRef = (value: string | true | undefined) => {
  if (!value || value === true) return undefined;
  const [path, line] = String(value).split(":");
  return { path, line: line ? Number(line) : undefined };
};
const textArg = () => (args["text-file"] ? readFileSync(args["text-file"] as string, "utf8") : typeof args.text === "string" ? args.text : null);
// The default browser, detached so this command can end right away.
const openInBrowser = (url: string) => {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
};

async function health(info: DaemonInfo) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-admin-token": info.adminToken }, signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

async function ensureDaemon(): Promise<DaemonInfo> {
  let info = readJson(daemonFile) as DaemonInfo | null;
  let status = info && (await health(info));
  if (status && status.version !== expectedVersion()) {
    // The skill was updated: replace the running daemon with the new code.
    await fetch(`http://127.0.0.1:${info!.port}/api/shutdown`, { method: "POST", headers: { "x-admin-token": info!.adminToken } }).catch(() => {});
    for (let i = 0; i < 30 && (await health(info!)); i++) await sleep(100);
    status = null;
  }
  if (status) return info!;

  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "daemon.log"), "a");
  // windowsHide: on Windows a detached process gets a console window of its own, and closing it would stop the daemon.
  spawn(process.execPath, [daemonScript], { detached: true, stdio: ["ignore", log, log], env: process.env, windowsHide: true }).unref();
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    info = readJson(daemonFile) as DaemonInfo | null;
    if (info && info.version === expectedVersion() && (await health(info))) return info;
  }
  throw new Error(`The daemon did not start. See ${join(HOME, "daemon.log")}`);
}

// `data` is the daemon's JSON answer, read as T; it is null on a 204, which only next-event sends.
async function api<T = unknown>(info: DaemonInfo, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { "x-admin-token": info.adminToken, ...(agent ? { [AGENT_HEADER]: encodeAgent(agent) } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 204) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return { status: res.status, data: data as T };
}

const need = (...keys: string[]) => {
  const missing = keys.filter((k) => !args[k] || args[k] === true);
  if (missing.length) {
    console.log(`${command} needs ${missing.map((k) => `--${k}`).join(", ")}`);
    process.exit(2);
  }
};

const describe = (t: CommentTarget) => {
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

const self = `node "${shellPath(join(here, "review.mts"))}"`;

// What the reviewer did, and what the agent runs next. Printed by wait and resume.
function explain(event: ReviewEvent, review: EventReview) {
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
  } else if (event.type === "review-submitted") {
    console.log(`Review for round ${event.round} of ${review.id} was sent with ${event.count} comments: ${shellPath(event.file)}`);
    console.log(`\nNext: read the file, then post your plan: ${self} plan --id ${review.id} --file <plan.json>`);
    console.log("Then run wait again in the background for the reviewer's decision.");
  } else if (event.type === "plan-decision" && event.decision.decision === "approve") {
    const kinds = Object.entries(event.decision.kinds ?? {});
    console.log(`The reviewer approved the plan for ${review.id}.`);
    if (kinds.length) console.log(`Kind changes by step: ${kinds.map(([step, kind]) => `step ${Number(step) + 1} -> ${kind}`).join(", ")}`);
    if (event.decision.note) console.log(`Note: ${event.decision.note}`);
    console.log(`\nNext: make the changes. Report each comment as you go: ${self} status --id ${review.id} --comment <id> --status working|fixed|answered|wontfix|noted --text "<short>"`);
    console.log(`Then collect --update, update the carried report.json and add review.replies, build, and publish: ${self} open --report <new json>`);
  } else if (event.type === "round-finished") {
    console.log(`Round ${event.round} of ${review.id} is finished: all ${event.count} comments are handled and no code changed. The review is done.`);
  } else if (event.type === "refresh") {
    const files = event.files.length ? `: ${event.files.slice(0, 10).join(", ")}${event.files.length > 10 ? ", ..." : ""}` : "";
    console.log(`The reviewer asked for an updated report: the code changed after round ${event.round} of ${review.id} was built${event.commits ? ` (${event.commits} new commits)` : ""}${files}.`);
    console.log(`\nNext: collect with --update (it carries report.json forward), update report.json for those files, build, and publish the same round: ${self} open --report <new json>`);
    console.log("Comments the reviewer wrote stay. Then run wait again in the background.");
  } else if (event.type === "plan-decision") {
    console.log(`The reviewer wants a different plan for ${review.id}.`);
    if (event.decision.note) console.log(`Note: ${event.decision.note}`);
    console.log(`\nNext: post a new plan with ${self} plan, then run wait again in the background.`);
  } else {
    console.log(JSON.stringify(event, null, 2));
  }
}

// The two events that end a review: sent with no comments, or a round whose comments are all handled
// without a code change.
const reviewDone = (event: ReviewEvent): event is Extract<ReviewEvent, { type: "review-submitted" | "round-finished" }> => (event.type === "review-submitted" && event.count === 0) || event.type === "round-finished";

// Tells the agent what the reviewer did. A finished review runs the project's onApproved hook first
// (hooks.mts), and the agent offers to open the pull request unless the hook took care of it.
async function handOver(event: ReviewEvent, review: EventReview, info: DaemonInfo) {
  explain(event, review);
  if (!reviewDone(event)) return;
  const hooks = await runReportHooks("onApproved", { dir: review.dir, round: event.round, url: `http://127.0.0.1:${info.port}/r/${review.id}` });
  if (hooks.failed) console.log("warning: the onApproved hook in .pr-report.json failed; tell the user what it printed.");
  if (hooks.ran && !hooks.failed)
    console.log("The project's onApproved hook ran; its output is above. Tell the user what it did. If it opened a pull request, tell the review page with the pr command; if not, offer to open the PR (ask first).");
  else console.log("Offer to open the PR (ask first).");
}

// ------------------------------------------------------------------ commands

// The commands. They return instead of calling process.exit(): on Windows, exiting right after a fetch
// tears libuv down while a background task still posts to the main thread, and Node aborts with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (nodejs/node#56645). Nothing keeps the
// process alive once a command is done, so it ends on its own.
async function main() {
  if (command === "open") {
    need("report");
    const info = await ensureDaemon();
    const { data } = await api<Published>(info, "POST", "/api/reviews", { report: resolve(args.report as string) });
    console.log(`Review: ${data.url}`);
    console.log(`Review id: ${data.id} (round ${data.round})`);
    if (data.republished) console.log(`Round ${data.round} was already published. It now uses this build; comments, plan and progress are kept.`);
    if (args.open && data.tabs === 0) {
      openInBrowser(data.url);
      console.log("Opened it in the browser.");
    } else if (data.tabs > 0) {
      console.log(
        data.republished
          ? `Open in ${data.tabs} tab(s); a reload shows this build.`
          : `Already open in ${data.tabs} tab(s); they show a banner for the new round.`,
      );
    }
    // The project's postRun hook, once a round: at its first build that is not a draft (hooks.mts).
    if (data.firstReal) {
      const hooks = await runReportHooks("postRun", { dir: data.dir, round: data.round, url: data.url });
      if (hooks.failed) console.log("warning: the postRun hook in .pr-report.json failed. The report is published; tell the user what the hook printed.");
    }
    // Nothing in this shell says which agent this is, so the page speaks of "your agent" until it is told.
    if (!agent) console.log(`note: the page does not know which agent you are. Add --agent-name "<the product you run in>" to review.mts commands so it can say.`);
    console.log(`Next: run in the background: ${self} wait --id ${data.id}`);
  } else if (command === "setup") {
    // The first-run page: the tools on this machine, light or dark, and a code theme. The installer
    // runs this after a first install; it works any time by hand too.
    const info = await ensureDaemon();
    const url = `http://127.0.0.1:${info.port}/setup`;
    if (args["no-open"]) console.log(`Setup page: ${url}`);
    else {
      openInBrowser(url);
      console.log(`Opened the setup page in your browser: ${url}`);
    }
    console.log(`Inbox of every review: http://127.0.0.1:${info.port}/`);
  } else if (command === "wait") {
    need("id");
    let info = await ensureDaemon();
    for (let failures = 0; ; ) {
      let result;
      try {
        result = await api<NextEvent>(info, "GET", `/api/r/${encodeURIComponent(args.id)}/next-event`);
        failures = 0;
      } catch (e) {
        // The daemon restarts when the skill is updated. Start it again and keep waiting.
        if (++failures > 3) {
          console.log(`The review daemon is not reachable (${(e as Error).message}). Run wait again in the background.`);
          return;
        }
        await sleep(1000);
        info = await ensureDaemon().catch(() => info);
        continue;
      }
      if (result.status === 204) continue;
      await handOver(result.data.event, result.data.review, info);
      return;
    }
  } else if (command === "resume") {
    const info = await ensureDaemon();
    let id = typeof args.id === "string" ? args.id : null;
    if (!id) {
      // This branch's review: the newest one whose files are in this repo's git folder.
      const git = (...a: string[]) => execFileSync("git", a, { cwd: resolve(typeof args.repo === "string" ? args.repo : "."), encoding: "utf8" }).trim();
      const gitDir = resolve(git("rev-parse", "--show-toplevel"), git("rev-parse", "--git-dir"));
      const branch = git("rev-parse", "--abbrev-ref", "HEAD");
      const { data } = await api<ReviewList>(info, "GET", "/api/reviews");
      const mine = data.reviews.filter((r) => r.branch === branch && (r.dir === join(gitDir, "pr-report") || r.dir.startsWith(gitDir)));
      id = mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
      if (!id) {
        console.log(`No review of ${branch} is open. Run /pr-report to start one.`);
        return;
      }
    }
    const { data } = await api<Resumed>(info, "GET", `/api/r/${encodeURIComponent(id)}/resume`);
    const { event, review } = data;
    console.log(`Picking up review ${review.id}, round ${review.round}: http://127.0.0.1:${info.port}/r/${review.id}\n`);
    if (event) await handOver(event, review, info);
    else if (review.phase === "working" && review.open.length) {
      console.log(`The fix loop for round ${review.round} was cut off: ${review.comments - review.open.length} of ${review.comments} comments are handled. Review file: ${shellPath(review.file)}`);
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
    const plan = JSON.parse(readFileSync(args.file as string, "utf8")) as PlanFile;
    const info = await ensureDaemon();
    await api(info, "POST", `/api/r/${encodeURIComponent(args.id)}/plan`, plan);
    console.log(`Plan posted with ${plan.steps.length} steps. The reviewer can approve it in the page or in the chat.`);
  } else if (command === "status") {
    need("id", "comment", "status");
    const info = await ensureDaemon();
    const { data } = await api<StatusSet>(info, "POST", `/api/r/${encodeURIComponent(args.id)}/status`, {
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
  } else if (command === "pr") {
    need("id", "url");
    const info = await ensureDaemon();
    const { data } = await api<PrSet>(info, "POST", `/api/r/${encodeURIComponent(args.id)}/pr`, { url: args.url, title: typeof args.title === "string" ? args.title : undefined });
    console.log(`The page shows pull request #${data.pr.number} (${data.pr.state.toLowerCase()}) and follows it: when it is merged on GitHub, the page says so.`);
  } else if (command === "list") {
    const info = await ensureDaemon();
    const { data } = await api<ReviewList>(info, "GET", "/api/reviews");
    if (!data.reviews.length) console.log("No reviews yet.");
    for (const r of data.reviews) console.log(`${r.id.padEnd(36)} round ${String(r.round).padEnd(3)} ${(r.pr?.state === "MERGED" ? "merged" : r.phase).padEnd(10)} ${r.url}`);
    console.log(`\nInbox: http://127.0.0.1:${info.port}/`);
  } else if (command === "stop") {
    const info = readJson(daemonFile) as DaemonInfo | null;
    if (!info || !existsSync(daemonFile)) console.log("The daemon is not running.");
    else {
      await api(info, "POST", "/api/shutdown").catch(() => {});
      console.log("Stopped the daemon.");
    }
  } else {
    console.log("Usage: review.mts open|wait|resume|answer|plan|status|pr|list|setup|stop (see the top of this file)");
    process.exit(2);
  }
}

// A failure (a missing file, an answer the daemon refused) must not throw out of main(): an uncaught error after a
// fetch exits the way process.exit did, and on Windows that aborts Node with the libuv assertion from nodejs/node#56645.
// So the reason is printed and the process ends on its own with exit code 1.
try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
