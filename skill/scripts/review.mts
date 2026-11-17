#!/usr/bin/env node
// The agent's side of a review. Talks to the reflektor daemon and starts it when needed.
//
//   open    --report <json> [--open]     publish a report (a new review, or the next round of one)
//   wait    --id <review>                block until the reviewer does something; run it as SKILL.md step 7 says
//   answer  --id <review> --question <id> (--text <t> | --text-file <f>) [--ref path:line]
//   plan    --id <review> --file <plan.json>
//   status  --id <review> --comment <id> --status working|fixed|answered|wontfix|noted [--text <t>] [--ref path:line]
//   pr      --id <review> --url <pull request url> [--title <t>]   show the pull request you just opened; the page follows it from there
//   resume  [--id <review>] [--repo .]   pick up a review in a new session: what is waiting, and what to do
//   list                                  every review the daemon knows
//   setup   [--no-open]                   open the first-run setup page (tools, light or dark, code theme)
//   stop                                  stop the daemon
//   version                               this version, the newest release, and whether an update waits
//   update                                install the newest release now and restart the daemon on it; open pages
//                                         reload and waiting agents stop (updates.mjs)
//   rollback                              go back to the release installed before this one
//
// Reflektor, where an organization reads its members' reports (reflektor.mjs):
//
//   login   [--no-open]                   sign in in the browser (device flow); the token goes to ~/.reflektor/reflektor.json
//   logout                                sign out here: deletes that file and nothing else
//   whoami                                the account this machine publishes as
//   publish [--id <review>] [--repo .] [--org <slug>]   this branch's newest finished round, now. With an open pull
//                                         request the daemon does it by itself (see daemon.mjs)
//
// Every command tells the daemon which agent is calling, worked out from the shell it runs in (agent.mjs).
// --agent <id> says it outright; --agent-name "<product>" is the agent's own answer when nothing else is known.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { CommentTarget, LiveQuestion, PrState, ReviewComment } from "../schema/types.js";
import { AGENT_HEADER, detectAgent, encodeAgent } from "./agent.mjs";
import { runReportHooks } from "./hooks.mjs";
import { finishDeviceLogin, forgetLogin, LOGIN_FILE, type Organization, readLogin, reflektorConfig, saveLogin, startDeviceLogin, whoami } from "./reflektor.mjs";
import { needWritable, SANDBOX_HINT, shellPath } from "./repo.mjs";
import { readSettings } from "./settings.mjs";
import { readInstall, rollback } from "./install.mjs";
import { managedInstall, terminalLine, updateCommand, type UpdateInfo } from "./updates.mjs";
import { fromSkills, isRelease, readVersion } from "./version.mjs";

// daemon.json, which the daemon writes when it starts: where it listens and its admin token.
type DaemonInfo = { port: number; pid: number; version: string; adminToken: string; startedAt: string };
// What GET /api/health answers.
type Health = { ok: boolean; version: string; pid: number };
// A review's phase in the daemon.
type Phase = "reviewing" | "sent" | "planning" | "working" | "done";
// A pull request as the daemon follows it (prFrom in daemon.mjs).
type FollowedPr = { number: number; url: string; title: string | null; state: PrState; base: string | null; mergedAt: string | null; checkedAt: string };
// The reviewer's decision on the agent's plan. `kinds` maps a step's index to the kind the reviewer chose for it.
type PlanDecision = { decision: "approve" | "changes"; note: string | null; kinds: Record<string, string>; at: string };
// What the reviewer did, as the daemon queues it (pushEvent in daemon.mjs). A question's target is read for `fix`, which only some targets have.
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
// What GET /api/reviews answers: liveState in daemon.mjs with each review's folder and page URL, only the fields read here.
type ReviewList = { reviews: { id: string; branch: string; dir: string; round: number; phase: Phase; updatedAt: string; url: string; pr: FollowedPr | null }[] };
// What POST /api/reviews answers: the round just published.
type Published = { id: string; round: number; republished: boolean; firstReal: boolean; url: string; tabs: number; dir: string };
// What POST /api/r/<id>/status answers: whether that status finished the round.
type StatusSet = { ok: true; finished: boolean; round: number };
// What POST /api/r/<id>/pr answers: the pull request the page follows now.
type PrSet = { pr: FollowedPr };
// The plan file the agent wrote; only its steps are counted here.
type PlanFile = { steps: unknown[] };
// What POST /api/r/<id>/reflektor answers (PublishAnswer in daemon.mjs).
type PublishAnswer = { ok: boolean; reason: string | null; message: string; round: number | null; url: string | null; organization: string | null; organizations?: Organization[]; already?: boolean };

const here = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.REFLEKTOR_HOME ?? join(homedir(), ".reflektor");
const daemonScript = join(here, "daemon.mjs");
const daemonFile = join(HOME, "daemon.json");
// Read from disk each time: a waiter that started before the skill was rebuilt must take the new daemon as current,
// not shut it down as out of date.
const expectedVersion = () => readVersion();

// An installed release this script is no longer part of: reflektor was updated (or rolled back) while it ran, so the
// daemon belongs to the other version and must not be replaced by this one's.
const superseded = () => {
  const install = readInstall();
  return Boolean(install && isRelease() && install.version !== readVersion());
};
const updatedMessage = (version = readInstall()?.version ?? "a new version") =>
  `reflektor was updated to ${version} while this was running, so it stopped here. Comments and drafts are saved. Tell the user, then continue ${agent?.resume ? `with ${agent.resume}` : "by asking the agent to resume the review"} (review.mjs resume), which uses the new version.`;
// GET /api/update in daemon.mjs.
type UpdateAnswer = UpdateInfo & { state: string; error: string | null; target: string | null; waiting: number };
// The line every answer the agent relays ends with while an update waits (updates.mjs).
const noteUpdate = () => {
  const line = terminalLine();
  if (line) console.log(`\nnote: ${line}`);
};

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
const textArg = () => {
  const file = args["text-file"];
  // A flag with no value parses as true. main() prints the reason and ends with exit code 1.
  if (file === true) throw new Error(`${command} needs a file path after --text-file`);
  return file ? readFileSync(file, "utf8") : typeof args.text === "string" ? args.text : null;
};
// The default browser, detached so this command can end right away. Resolves false when the opener is missing or
// says it failed, as it does in a sandbox that blocks it. explorer.exe exits with 1 even when it worked, so on
// Windows only a missing opener counts. An opener still running after 3 seconds counts as having worked.
const openInBrowser = (url: string): Promise<boolean> =>
  new Promise((done) => {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    const settle = (opened: boolean) => {
      clearTimeout(timer);
      child.unref();
      done(opened);
    };
    const timer = setTimeout(() => settle(true), 3000);
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(process.platform === "win32" || code === 0));
  });

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
    if (superseded()) throw new Error(updatedMessage());
    // The skill was rebuilt: replace the running daemon with the new code.
    await fetch(`http://127.0.0.1:${info!.port}/api/shutdown`, { method: "POST", headers: { "x-admin-token": info!.adminToken } }).catch(() => {});
    for (let i = 0; i < 30 && (await health(info!)); i++) await sleep(100);
    status = null;
  }
  if (status) return info!;
  if (superseded()) throw new Error(updatedMessage());

  needWritable([HOME]);
  const logFile = join(HOME, "daemon.log");
  const logStart = existsSync(logFile) ? statSync(logFile).size : 0;
  const log = openSync(logFile, "a");
  // windowsHide: on Windows a detached process gets a console window of its own, and closing it would stop the daemon.
  spawn(process.execPath, [daemonScript], { detached: true, stdio: ["ignore", log, log], env: process.env, windowsHide: true }).unref();
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    info = readJson(daemonFile) as DaemonInfo | null;
    if (info && info.version === expectedVersion() && (await health(info))) return info;
  }
  if (/listen (EPERM|EACCES)/.test(readFileSync(logFile).subarray(logStart).toString("utf8"))) throw new Error(`The daemon could not start a local server on 127.0.0.1. ${SANDBOX_HINT}`);
  throw new Error(`The daemon did not start. See ${logFile}`);
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
    case "screenshot":
      return `the screenshot "${t.caption}" (${t.file} in the review's folder${t.pin ? `, pinned at ${Math.round(t.pin.x * 100)}% across and ${Math.round(t.pin.y * 100)}% down` : ""})`;
    default:
      return `${t.type}: ${t.text ?? ""}`;
  }
};

// The path the agent ran this with, not where it resolves to: a release is a link to ~/.reflektor/versions/<version>/,
// and the commands printed here must keep working after an update moves the link.
const self = `node "${shellPath(process.argv[1] && /review\.mjs$/.test(process.argv[1]) ? process.argv[1] : join(here, "review.mjs"))}"`;

// This branch's review: the newest one whose files are in this repo's git folder (--repo, else the working folder).
// Prints why when there is none.
async function branchReview(info: DaemonInfo): Promise<string | null> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: resolve(typeof args.repo === "string" ? args.repo : "."), encoding: "utf8" }).trim();
  const gitDir = resolve(git("rev-parse", "--show-toplevel"), git("rev-parse", "--git-dir"));
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const { data } = await api<ReviewList>(info, "GET", "/api/reviews");
  const mine = data.reviews.filter((r) => r.branch === branch && (r.dir === join(gitDir, "reflektor") || r.dir.startsWith(gitDir)));
  const id = mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  if (!id) console.log(`No review of ${branch} is open. ${agent?.resume ? `Run ${agent.resume.replace(/ resume$/, "")} to start one.` : "Ask for a review report to start one."}`);
  return id ?? null;
}

// The organization to publish to, asked in the terminal. null when the answer names none of them.
async function chooseOrganization(organizations: Organization[]): Promise<string | null> {
  console.log("Several of your organizations approve this repository:");
  organizations.forEach((o, i) => console.log(`  ${i + 1}. ${o.name} (${o.slug})`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("Publish to which one? Its number or slug: ")).trim();
    return (organizations[Number(answer) - 1] ?? organizations.find((o) => o.slug.toLowerCase() === answer.toLowerCase()))?.slug ?? null;
  } finally {
    prompt.close();
  }
}

// What the reviewer did, and what the agent runs next. Printed by wait and resume.
function explain(event: ReviewEvent, review: EventReview) {
  if (event.type === "question") {
    const q = event.question;
    console.log(`Live question ${q.id} in review ${review.id}`);
    console.log(`About: ${describe(q.target)}`);
    if (q.target.type === "line") console.log(["```", q.target.code, "```"].join("\n"));
    if (q.target.type === "screenshot") console.log(`Picture: ${shellPath(join(review.dir, q.target.file))} (look at it before you answer)`);
    if (q.target.fix) console.log(`Suggested fix shown with it: ${q.target.fix}`);
    console.log(`Question: ${q.text}`);
    console.log(`\nAnswer: ${self} answer --id ${review.id} --question ${q.id} --text "<answer>"`);
    console.log("Then run wait again, the same way as before.");
  } else if (event.type === "review-submitted" && event.count === 0) {
    console.log(`The reviewer finished round ${event.round} of ${review.id} with no comments. The review is done.`);
  } else if (event.type === "review-submitted") {
    console.log(`Review for round ${event.round} of ${review.id} was sent with ${event.count} comments: ${shellPath(event.file)}`);
    console.log(`\nNext: read the file, then post your plan: ${self} plan --id ${review.id} --file <plan.json>`);
    console.log("Then run wait again, the same way as before, for the reviewer's decision.");
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
    console.log("Comments the reviewer wrote stay. Then run wait again, the same way as before.");
  } else if (event.type === "plan-decision") {
    console.log(`The reviewer wants a different plan for ${review.id}.`);
    if (event.decision.note) console.log(`Note: ${event.decision.note}`);
    console.log(`\nNext: post a new plan with ${self} plan, then run wait again, the same way as before.`);
  } else {
    console.log(JSON.stringify(event, null, 2));
  }
}

// The two events that end a review: sent with no comments, or a round whose comments are all handled
// without a code change.
const reviewDone = (event: ReviewEvent): event is Extract<ReviewEvent, { type: "review-submitted" | "round-finished" }> => (event.type === "review-submitted" && event.count === 0) || event.type === "round-finished";

// Tells the agent what the reviewer did. A finished review runs the project's onApproved hook first
// (hooks.mjs), and the agent offers to open the pull request unless the hook took care of it.
async function handOver(event: ReviewEvent, review: EventReview, info: DaemonInfo) {
  explain(event, review);
  if (!reviewDone(event)) return;
  const hooks = await runReportHooks("onApproved", { dir: review.dir, round: event.round, url: `http://127.0.0.1:${info.port}/r/${review.id}` });
  if (hooks.failed) console.log("warning: the onApproved hook in .reflektor.json failed; tell the user what it printed.");
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
      console.log((await openInBrowser(data.url)) ? "Opened it in the browser." : `Could not open the browser from here. Give the user the review address to open: ${data.url}`);
    } else if (data.tabs > 0) {
      console.log(
        data.republished
          ? `Open in ${data.tabs} tab(s); a reload shows this build.`
          : `Already open in ${data.tabs} tab(s); they show a banner for the new round.`,
      );
    }
    // The project's postRun hook, once a round: at its first build that is not a draft (hooks.mjs).
    if (data.firstReal) {
      const hooks = await runReportHooks("postRun", { dir: data.dir, round: data.round, url: data.url });
      if (hooks.failed) console.log("warning: the postRun hook in .reflektor.json failed. The report is published; tell the user what the hook printed.");
    }
    // Nothing in this shell says which agent this is, so the page speaks of "your agent" until it is told.
    if (!agent) console.log(`note: the page does not know which agent you are. Add --agent-name "<the product you run in>" to review.mjs commands so it can say.`);
    console.log(`Next: start the waiter (SKILL.md step 7 says whether in the background or the foreground): ${self} wait --id ${data.id}`);
    noteUpdate();
  } else if (command === "setup") {
    // The first-run page: the tools on this machine, light or dark, and a code theme. The installer
    // runs this after a first install; it works any time by hand too.
    const info = await ensureDaemon();
    const url = `http://127.0.0.1:${info.port}/setup`;
    if (args["no-open"]) console.log(`Setup page: ${url}`);
    else {
      console.log((await openInBrowser(url)) ? `Opened the setup page in your browser: ${url}` : `Could not open the browser from here. Open the setup page: ${url}`);
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
        // An update stops every waiter: the daemon answers "reflektor-updated", or is gone and a newer version is
        // installed. Exit code 3 tells the agent this is not a failure.
        if ((e as Error).message === "reflektor-updated" || superseded()) {
          console.log(updatedMessage());
          process.exitCode = 3;
          return;
        }
        // The daemon restarts when the skill is rebuilt. Start it again and keep waiting.
        if (++failures > 3) {
          console.log(`The review daemon is not reachable (${(e as Error).message}). Run wait again.`);
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
    const id = typeof args.id === "string" ? args.id : await branchReview(info);
    if (!id) return;
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
      console.log(`\nNext: start the waiter (SKILL.md step 7 says whether in the background or the foreground): ${self} wait --id ${review.id}`);
    }
    noteUpdate();
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
  } else if (command === "login") {
    // The device flow: the browser approves this machine, and the token is saved for the daemon and this script.
    const config = reflektorConfig();
    const before = readLogin();
    const start = await startDeviceLogin(config);
    console.log(`To sign in to Reflektor, open ${start.verificationUriComplete} and check that it shows the code ${start.userCode}.`);
    if (!args["no-open"]) {
      if (await openInBrowser(start.verificationUriComplete)) console.log("Opened it in your browser.");
      else console.log("Could not open the browser from here. Open the address above.");
    }
    console.log("Waiting for you to approve it there...");
    const login = await finishDeviceLogin(config, start);
    // Signing in again as the same person keeps the organizations picked per repository.
    const same = before && before.apiUrl === login.apiUrl && before.user.id === login.user.id;
    saveLogin({ ...login, organizations: same ? before.organizations : {} });
    console.log(`Signed in to Reflektor as ${login.user.name ? `${login.user.name} <${login.user.email}>` : login.user.email}. The token is in ${shellPath(LOGIN_FILE)}, readable by you only.`);
    if (readSettings().reflektorAutoPublish)
      console.log("A branch's report now goes to your organization on Reflektor while its pull request is open, once an admin approved the repository. Turn that off in the report page's Settings.");
  } else if (command === "logout") {
    const login = readLogin();
    if (!forgetLogin()) console.log("Not signed in to Reflektor.");
    else console.log(`Signed out of Reflektor: deleted ${shellPath(LOGIN_FILE)}.${login ? ` To end the token on Reflektor's side too, revoke it on ${login.appUrl}/account.` : ""}`);
  } else if (command === "whoami") {
    const login = readLogin();
    if (!login) {
      console.log(`Not signed in to Reflektor. Sign in with: ${self} login`);
      return;
    }
    try {
      const user = await whoami(login);
      console.log(`Signed in to Reflektor (${login.apiUrl}) as ${user.name ? `${user.name} <${user.email}>` : user.email}.`);
    } catch (e) {
      const error = e as Error & { code?: string };
      console.log(error.message);
      if (error.code === "unauthorized") console.log(`Sign in again with: ${self} login`);
      else console.log(`Saved login: ${login.user.email} on ${login.apiUrl}.`);
      process.exitCode = 1;
    }
  } else if (command === "publish") {
    // Through the daemon, which keeps what went up so nothing is sent twice, and shows it in the page.
    if (!readLogin()) {
      console.log(`Not signed in to Reflektor. Sign in first: ${self} login`);
      process.exitCode = 1;
      return;
    }
    const info = await ensureDaemon();
    const id = typeof args.id === "string" ? args.id : await branchReview(info);
    if (!id) return;
    const send = (organization: string | null) => api<PublishAnswer>(info, "POST", `/api/r/${encodeURIComponent(id)}/reflektor`, { organization });
    let { data } = await send(typeof args.org === "string" ? args.org : null);
    // Several organizations approve the repo and none was picked for it yet: ask, when someone is at the terminal.
    if (data.reason === "organization_required" && data.organizations?.length && process.stdin.isTTY) {
      const picked = await chooseOrganization(data.organizations);
      if (picked) ({ data } = await send(picked));
    }
    console.log(data.message);
    noteUpdate();
    if (data.ok) return;
    if (data.reason === "organization_required" || data.reason === "unknown_organization")
      console.log(`Publish to one of them with: ${self} publish --id ${id} --org ${data.organizations?.[0]?.slug ?? "<slug>"}`);
    if (data.reason === "unauthorized" || data.reason === "signed_out") console.log(`Sign in again with: ${self} login`);
    process.exitCode = 1;
  } else if (command === "version") {
    console.log(`reflektor ${readVersion()}${isRelease() ? "" : " (a build from a checkout, which does not update itself)"}`);
    const install = readInstall();
    if (install) console.log(`Installed release: ${install.version} for ${install.targets.join(", ")}${install.previous ? `; rollback goes to ${install.previous}` : ""}.`);
    else if (fromSkills()) console.log("Installed with npx skills.");
    const info = await ensureDaemon();
    const { data } = await api<UpdateAnswer>(info, "POST", "/api/update/check");
    const run = updateCommand() ?? `${self} update`;
    if (data.status === "required") console.log(`Update needed: Reflektor takes reports from ${data.minimum} or newer. Run: ${run}`);
    else if (data.status === "available") console.log(`reflektor ${data.latest} is available. Run: ${run}`);
    else if (data.latest) console.log(`Up to date (the newest release is ${data.latest}).`);
    else console.log("No release information yet.");
  } else if (command === "update") {
    const skillsCommand = updateCommand();
    if (skillsCommand) {
      console.log(`npx skills installed this reflektor, so it updates with npx skills. Run: ${skillsCommand}`);
      process.exitCode = 1;
      return;
    }
    if (!managedInstall() && process.env.REFLEKTOR_UPDATE_CHECK !== "1") {
      console.log("This reflektor is a build from a checkout, so it does not update itself. Update it with: git pull && pnpm build && pnpm run deploy");
      process.exitCode = 1;
      return;
    }
    const info = await ensureDaemon();
    let { data } = await api<UpdateAnswer>(info, "POST", "/api/update");
    console.log("Updating reflektor. Open pages reload, and agents waiting on a review stop and say so.");
    for (let i = 0; i < 600 && !["failed", "restarting"].includes(data.state); i++) {
      await sleep(500);
      data = (await api<UpdateAnswer>(info, "GET", "/api/update").catch(() => ({ data: { ...data, state: "restarting" } }))).data;
    }
    if (data.state === "failed") {
      console.log(`The update did not happen: ${data.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Installed reflektor ${data.target ?? readInstall()?.version}. The daemon restarted on it.`);
    console.log("An agent session that already loaded reflektor keeps the old instructions until it loads reflektor again.");
  } else if (command === "rollback") {
    const back = rollback();
    const info = readJson(daemonFile) as DaemonInfo | null;
    if (info) await api(info, "POST", "/api/shutdown").catch(() => {});
    console.log(`Back on reflektor ${back.version}. The daemon starts on it with the next command.`);
  } else if (command === "stop") {
    const info = readJson(daemonFile) as DaemonInfo | null;
    if (!info || !existsSync(daemonFile)) console.log("The daemon is not running.");
    else {
      await api(info, "POST", "/api/shutdown").catch(() => {});
      console.log("Stopped the daemon.");
    }
  } else {
    console.log("Usage: review.mjs open|wait|resume|answer|plan|status|pr|list|setup|stop|version|update|rollback|login|logout|whoami|publish (see the top of this file)");
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
