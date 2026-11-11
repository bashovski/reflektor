#!/usr/bin/env node
// One local server for every review: http://127.0.0.1:7337 (or the next free port).
// Pages talk to it to save comments, ask questions and send reviews; agents talk to it through
// review.mjs to answer, post plans, report progress and publish new rounds. It streams each
// review's live state to open pages with Server-Sent Events.
//
// Each repo's review folder (<git folder>/pr-report) stays the source of truth: the daemon only keeps
// a list of those folders in ~/.pr-report/reviews.json, so a restart loses nothing.
//
// Started by review.mjs when needed. Stops itself after 4 hours without activity.

import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readChecksRun } from "./checks-run.mjs";
import { AGENT_HEADER, cleanAgent, decodeAgent } from "./agent.mjs";
import { purgeCache, whoAmI } from "./identity.mjs";
import { replaceFile } from "./repo.mjs";

const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const FIRST_PORT = Number(process.env.PR_REPORT_PORT ?? 7337);
const IDLE_MS = Number(process.env.PR_REPORT_IDLE_MINUTES ?? 240) * 60_000;
const LONG_POLL_MS = 25_000;
const REDELIVER_MS = 120_000;
const MAX_BODY = 5 * 1024 * 1024;
export const VERSION = createHash("sha1").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12);

mkdirSync(HOME, { recursive: true });
const daemonFile = join(HOME, "daemon.json");
const registryFile = join(HOME, "reviews.json");
const lockFile = join(HOME, "daemon.lock");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
// The temp file carries the pid, so two processes writing the same file never move each other's.
const writeJson = (file, value, mode) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  replaceFile(tmp, file);
};
const now = () => new Date().toISOString();
const startedAt = now();
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ single instance

// The lock file holds its owner's pid. A daemon writes the pid just after creating the file, so an
// empty lock a few seconds old at most belongs to a daemon starting right now. Treating it as stale
// let two daemons start together when several sessions restarted the daemon at once.
const lockOwner = () => {
  try {
    return { pid: Number(readFileSync(lockFile, "utf8")), age: Date.now() - statSync(lockFile).mtimeMs };
  } catch {
    return null;
  }
};
function takeLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      const owner = lockOwner();
      if (!owner) continue;
      if (owner.pid ? pidAlive(owner.pid) : owner.age < 5000) return false;
      // Stale: its daemon is gone. Remove it only if it still names that daemon, not one that took it since.
      if (lockOwner()?.pid === owner.pid) rmSync(lockFile, { force: true });
    }
  }
  return false;
}
if (!takeLock()) {
  console.log("Another pr-report daemon is already running.");
  process.exit(0);
}

// Tokens survive restarts, so tabs left open across a daemon update keep working.
const secretsFile = join(HOME, "secrets.json");
const secrets = readJson(secretsFile, null) ?? { pageToken: randomBytes(24).toString("hex"), adminToken: randomBytes(24).toString("hex") };
writeJson(secretsFile, secrets, 0o600);
const { pageToken, adminToken } = secrets;

// ------------------------------------------------------------------ reviews

// A review is one branch in one repo, across rounds. Its files live in `dir`.
const reviews = new Map();
const registry = readJson(registryFile, []);

const stateFile = (r) => join(r.dir, "review-state.json");
const draftFile = (r) => join(r.dir, "review-draft.json");
const questionsFile = (r, round) => join(r.dir, `questions-${round}.json`);
const reviewFile = (r, round) => join(r.dir, `review-${round}.json`);

function loadReview(entry) {
  if (!existsSync(entry.dir)) return null;
  const saved = readJson(join(entry.dir, "review-state.json"), {});
  const r = {
    id: entry.id,
    dir: entry.dir,
    title: entry.title,
    tag: entry.tag,
    avatar: entry.avatar ?? null,
    checksFile: entry.checksFile ?? join(entry.dir, "checks.json"),
    repo: entry.repo,
    branch: entry.branch,
    archived: entry.archived ?? null,
    rounds: saved.rounds ?? [],
    phase: saved.phase ?? "reviewing",
    statuses: saved.statuses ?? {},
    plan: saved.plan ?? null,
    pr: saved.pr ?? null,
    agent: cleanAgent(saved.agent),
    // Events saved before handling was tracked count as handled once delivered.
    events: (saved.events ?? []).map((e) => ("handledAt" in e ? e : { ...e, handledAt: e.deliveredAt })),
    lastAgentActivity: saved.lastAgentActivity ?? null,
    updatedAt: saved.updatedAt ?? now(),
  };
  r.round = r.rounds.at(-1)?.round ?? 1;
  r.questions = readJson(questionsFile(r, r.round), []);
  r.checks = readChecksRun(r.checksFile);
  return r;
}
for (const entry of registry) {
  const r = loadReview(entry);
  if (r) reviews.set(r.id, r);
}

const saveRegistry = () =>
  writeJson(
    registryFile,
    [...reviews.values()].map(({ id, dir, title, tag, repo, branch, avatar, checksFile, archived }) => ({ id, dir, title, tag, repo, branch, avatar, checksFile, archived })),
  );

function save(r) {
  r.updatedAt = now();
  writeJson(stateFile(r), {
    rounds: r.rounds,
    phase: r.phase,
    statuses: r.statuses,
    plan: r.plan,
    pr: r.pr ?? null,
    agent: r.agent ?? null,
    events: r.events,
    lastAgentActivity: r.lastAgentActivity,
    updatedAt: r.updatedAt,
  });
  writeJson(questionsFile(r, r.round), r.questions);
  broadcast(r);
  wakeWaiters(r);
}

// A round's report data: the JSON file build.mjs wrote, or the data inside an exported page.
const roundFile = (entry) => entry.file ?? entry.html;
function roundText(file) {
  if (!file || !existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (extname(file) !== ".html") return text;
  return text.match(/<script id="pr-report-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? null;
}

const submittedComments = (r) => (r.phase === "reviewing" ? [] : (readJson(reviewFile(r, r.round), {}).comments ?? []));

// A round that changed no code is finished once every comment has a final status: no new round will
// come to end it. Comments in plan steps the reviewer skipped need no status. A `fixed` comment means
// new code, so that round ends when the agent publishes the next one.
function finishIfSettled(r) {
  if (r.phase !== "working") return false;
  const comments = submittedComments(r);
  const skipped = new Set((r.plan?.steps ?? []).flatMap((s, i) => ((r.plan.decision?.kinds?.[i] ?? s.kind) === "skip" ? s.comments : [])));
  const statuses = comments.filter((c) => !skipped.has(c.id)).map((c) => r.statuses[c.id]?.status);
  if (!comments.length || statuses.some((s) => !s || s === "working" || s === "fixed")) return false;
  r.phase = "done";
  pushEvent(r, "round-finished", { round: r.round, count: comments.length });
  return true;
}

// What an open page needs to know, sent on every change.
const liveState = (r) => ({
  id: r.id,
  title: r.title,
  repo: r.repo,
  branch: r.branch,
  round: r.round,
  phase: r.phase,
  statuses: r.statuses,
  plan: r.plan,
  questions: r.questions.map(({ deliveredAt: _, ...q }) => q),
  submitted: submittedComments(r),
  checks: r.checks ?? null,
  // Changes when the agent publishes the same round again; open pages then reload its data.
  roundBuiltAt: r.rounds.find((x) => x.round === r.round)?.builtAt ?? null,
  lastAgentActivity: r.lastAgentActivity,
  // Code that changed after the current round was built; null when it still matches.
  drift: r.drift ?? null,
  // The branch's pull request as last seen: told by the agent, or polled from GitHub. The page
  // prefers it to the one frozen in the report, which may be older.
  pr: r.pr ?? null,
  // The agent that called last, in the words the page shows; null until one has said who it is.
  agent: r.agent ?? null,
  // Whether an agent waits for this review's events, and since when the oldest event waits for one.
  // The page warns when nobody picks up what the reviewer sent.
  listening: listening(r),
  undeliveredSince: r.events.find((e) => !e.deliveredAt && !answered(r, e))?.at ?? null,
  updatedAt: r.updatedAt,
});

// Every call from review.mjs says which agent makes it (agent.mjs). The review keeps the last one, so the page
// names whoever is on the other side now, also after another agent picked the review up. A call that names
// nobody, such as one typed by hand, changes nothing. True when the agent changed.
function noteAgent(r, req) {
  const agent = decodeAgent(req.headers[AGENT_HEADER]);
  if (!agent || JSON.stringify(agent) === JSON.stringify(r.agent ?? null)) return false;
  r.agent = agent;
  return true;
}

// ------------------------------------------------------------------ live stream to pages (SSE)

const streams = new Set();
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
// What open pages show as the daemon's status: version and uptime, and Node for bug reports.
const daemonInfo = () => ({ version: VERSION, pid: process.pid, node: process.version, startedAt });
const watches = (res, id) => res.watchAll || res.watching.has(id);
function broadcast(r) {
  for (const res of streams) if (watches(res, r.id)) sse(res, "state", liveState(r));
}
setInterval(() => {
  for (const res of streams) res.write(": keep-alive\n\n");
}, 20_000).unref();
// Open report tabs check in every 20 seconds; a tab counts as open for 45 seconds after its last check-in.
// (Tabs share one event stream, so the stream itself cannot tell which reviews are on screen.)
const presence = new Map();
const openTabs = (r) => {
  const tabs = presence.get(r.id);
  if (!tabs) return 0;
  for (const [tab, seen] of tabs) if (Date.now() - seen > 45_000) tabs.delete(tab);
  return tabs.size;
};

// ------------------------------------------------------------------ agent events (long poll)

const waiters = new Map(); // review id -> [{ res, timer }]
// A waiter reconnects right after each long poll ends, so it counts as listening for a short while
// after it leaves.
const waiterLeft = new Map(); // review id -> ms
const LISTEN_GRACE_MS = 30_000;
const listening = (r) => (waiters.get(r.id)?.length ?? 0) > 0 || Date.now() - (waiterLeft.get(r.id) ?? 0) < LISTEN_GRACE_MS;
function waiterGone(r) {
  waiterLeft.set(r.id, Date.now());
  setTimeout(() => !listening(r) && broadcast(r), LISTEN_GRACE_MS + 500).unref();
}

const answered = (r, e) => e.type === "question" && Boolean(r.questions.find((q) => q.id === e.questionId)?.answer);

function nextEvent(r) {
  const ready = (e) => !e.deliveredAt || (e.type === "question" && Date.now() - Date.parse(e.deliveredAt) > REDELIVER_MS);
  for (const e of r.events) {
    if (answered(r, e)) continue;
    if (ready(e)) return e;
  }
  return null;
}

// An event is handled when the agent acts on it: a sent review by a plan or a status, a plan
// decision by a status or a new plan, a question by its answer. Other events are news, handled once
// delivered. `resume` hands an agent in a new session the event a lost session never handled.
const needsAction = (e) => (e.type === "review-submitted" && e.count > 0) || e.type === "plan-decision" || e.type === "question" || e.type === "refresh";
function markHandled(r, ...types) {
  for (const e of r.events) if (types.includes(e.type) && !e.handledAt) e.handledAt = now();
}
const openEvent = (r) => r.events.find((e) => !e.handledAt && !answered(r, e)) ?? null;

function deliver(r, res, e = nextEvent(r)) {
  if (!e) return false;
  e.deliveredAt = now();
  if (!needsAction(e)) e.handledAt = e.deliveredAt;
  const payload = { ...e };
  if (e.type === "question") payload.question = r.questions.find((q) => q.id === e.questionId);
  send(res, 200, { event: payload, review: { id: r.id, round: r.round, dir: r.dir } });
  r.lastAgentActivity = now();
  save(r);
  return true;
}

function wakeWaiters(r) {
  const list = waiters.get(r.id) ?? [];
  while (list.length && nextEvent(r)) {
    const w = list.shift();
    clearTimeout(w.timer);
    deliver(r, w.res);
  }
}

function pushEvent(r, type, data) {
  r.events.push({ seq: (r.events.at(-1)?.seq ?? 0) + 1, type, at: now(), deliveredAt: null, handledAt: null, ...data });
  r.events = r.events.slice(-200);
}

// ------------------------------------------------------------------ HTTP helpers

const send = (res, status, body, type = "application/json", { framedByOwnPages = false } = {}) => {
  // Pages must not be framed by other sites (clickjacking on Send or Fix this). Nothing may frame them at all, with
  // one exception: /panel is made to be shown in a frame by the inbox, so this daemon's own pages may frame it, and
  // still no other site can.
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": framedByOwnPages ? "SAMEORIGIN" : "DENY",
    "content-security-policy": `frame-ancestors ${framedByOwnPages ? "'self'" : "'none'"}`,
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req) =>
  new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
const same = (given, expected) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const validTarget = (t) => t && typeof t.type === "string";
const validComments = (value) =>
  Array.isArray(value) && value.every((c) => c && typeof c.id === "string" && typeof c.text === "string" && validTarget(c.target));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// ------------------------------------------------------------------ pages

// The repo owner's picture from the report data, or its initials. Checked before it goes into HTML.
function avatarHtml(avatar) {
  if (!avatar) return "";
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar.image ?? "")) return `<img class="av" src="${avatar.image}" alt="">`;
  const color = /^#[0-9a-f]{6}$/i.test(avatar.color ?? "") ? avatar.color : "#71717a";
  return `<span class="av" style="background:${color}">${escapeHtml(String(avatar.initials ?? "").slice(0, 2))}</span>`;
}

// Ordered as the status groups show them: the two that wait on you first.
const PHASES = {
  reviewing: ["Waiting on you", "#b45309"],
  planning: ["Plan ready", "#7c3aed"],
  sent: ["Sent to the agent", "#2563eb"],
  working: ["Agent working", "#2563eb"],
  done: ["Done", "#059669"],
  merged: ["Merged", "#7c3aed"],
};
// The status the inbox shows: the review's phase, except that a merged pull request ends the review
// whatever round it was in. Nothing more will happen to a merged branch.
const statusOf = (r) => (r.pr?.state === "MERGED" ? "merged" : r.phase);

// Pull request states: the colors and icons of PR_STATES in viewer/src/lib/meta.ts. The colors here and in PHASES
// are picked for a white page; the stylesheet mixes each a little toward the text color (see `--c`), so a status
// word is darker on a light page and lighter on a dark one.
const PR_STATES = {
  OPEN: ["open", "#059669", "gitPullRequest"],
  MERGED: ["merged", "#7c3aed", "gitMerge"],
  CLOSED: ["closed", "#dc2626", "gitPullRequestClosed"],
};

// Lucide icons (ISC license), drawn in the text color.
const ICONS = {
  flame: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
  shieldCheck:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  sparkles:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  bug: '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  zap: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
  blocks: '<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
  // For the inbox's top bar and the reader's menu, the same Lucide icons the report's menu uses.
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  filter: '<path d="M2 5h20"/><path d="M6 12h12"/><path d="M9 19h6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  gitPullRequest: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  gitMerge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  gitPullRequestClosed: '<circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// Report tags: the same colors and Lucide icons as TAGS in viewer/src/lib/meta.ts, which draws the review page's
// pill (TagPill in viewer/src/components/ui.tsx). A change to one list needs the same change to the other.
const TAGS = {
  HOTFIX: ["#dc2626", "flame"],
  SECURITY: ["#be123c", "shieldCheck"],
  FEATURE: ["#7c3aed", "sparkles"],
  FIX: ["#0284c7", "bug"],
  PERF: ["#0d9488", "zap"],
  REFACTOR: ["#475569", "blocks"],
  CHORE: ["#71717a", "wrench"],
};
const tagPill = (tag) => {
  const [color, name] = TAGS[tag] ?? ["#71717a", null];
  return `<span class="tag" style="background:${color}">${name ? icon(name) : ""}${escapeHtml(tag ?? "")}</span>`;
};
// The branch's pull request as a small chip: its number in the state's color, the state and title on hover.
const prChip = (pr) => {
  if (!pr) return "";
  const [label, color, name] = PR_STATES[pr.state] ?? PR_STATES.OPEN;
  return `<span class="pr" data-state="${escapeHtml(pr.state)}" style="--c:${color}" title="Pull request #${Number(pr.number)}, ${label}${pr.title ? `: ${escapeHtml(pr.title)}` : ""}">${icon(name)}#${Number(pr.number)}</span>`;
};

// The review icon from viewer/src/lib/favicon.ts in gray, with a red dot while a review waits on you.
const inboxIcon = (dot) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#52525b"/>` +
      `<path transform="translate(8 8) scale(2)" d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" fill="none" stroke="white" stroke-width="2.6" stroke-linejoin="round"/>` +
      (dot ? `<circle cx="50" cy="14" r="15" fill="white"/><circle cx="50" cy="14" r="11" fill="#ef4444"/>` : "") +
      `</svg>`,
  )}`;

const megabytes = (bytes) => (bytes < 100_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

// "acme-labs" for acme-labs/library, "group/sub" for a GitLab subgroup, "" for a repo without a remote.
const ownerOf = (repo) => (repo.includes("/") ? repo.slice(0, repo.lastIndexOf("/")) : "");

// One review. The data attributes are what the page groups, sorts and filters by.
function inboxRow(r) {
  const status = statusOf(r);
  const [phaseLabel, color] = r.archived ? ["Archived", "#71717a"] : (PHASES[status] ?? [status, "#71717a"]);
  // A row names its own agent; the groups and filters above keep the neutral words, since they span agents.
  const who = r.agent?.name;
  const label = r.archived || !who ? phaseLabel : status === "sent" ? `Sent to ${escapeHtml(who)}` : status === "working" ? `${escapeHtml(who)} working` : phaseLabel;
  const waiting = r.questions.filter((q) => !q.answer).length;
  const id = escapeHtml(r.id);
  const owner = ownerOf(r.repo);
  const actions = r.archived
    ? `<button class="act" data-act="restore" data-id="${id}">Restore</button><button class="act danger" data-act="delete" data-id="${id}" data-size="${megabytes(sizeOf(r))}">Delete</button>`
    : `<button class="act" data-act="archive" data-id="${id}" title="Move to Archived">Archive</button>`;
  const data = { owner, repo: r.repo, branch: r.branch, phase: status, tag: r.tag ?? "", updated: r.updatedAt, title: r.title ?? r.branch };
  return `<div class="row" ${Object.entries(data).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`).join(" ")}><a href="/r/${encodeURIComponent(r.id)}">
      <span class="tc">${tagPill(r.tag)}</span>
      <span class="main"><span class="title">${escapeHtml(r.title ?? r.branch)}</span>
      <span class="meta">${avatarHtml(r.avatar)}<span><span class="repo">${owner ? `<span class="owner">${escapeHtml(owner)}/</span>` : ""}${escapeHtml(r.repo.slice(owner ? owner.length + 1 : 0))} · </span><span class="br">${escapeHtml(r.branch)}</span> · round ${r.round}${waiting ? ` · ${waiting} question${waiting === 1 ? "" : "s"} waiting` : ""}</span>${prChip(r.pr)}</span></span>
      <span class="phase" style="--c:${color}">${label}</span>
      <time data-at="${r.updatedAt}"></time></a>${actions}</div>`;
}

// A toolbar menu: a button that opens a list of radios or checkboxes.
const menu = (key, iconName, label, body) =>
  `<div class="dd"><button type="button" class="tool" aria-haspopup="true" aria-expanded="false">${icon(iconName)}<span class="k">${label}</span><b data-label="${key}"></b>${icon("chevron")}</button><div class="menu" hidden>${body}</div></div>`;
const choices = (name, legend, options) =>
  `<fieldset><legend>${legend}</legend>${options.map(([value, html]) => `<label><input type="${name === "group" || name === "sort" ? "radio" : "checkbox"}" name="${name}" value="${escapeHtml(value)}">${html}</label>`).join("")}</fieldset>`;

// The inbox. `welcome` is set when the setup page hands over to it, so a first-timer is told they are
// done and how to start; without it, an empty inbox just says how to start.
function inboxPage(welcome = false) {
  const all = [...reviews.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = all.filter((r) => !r.archived);
  const archived = all.filter((r) => r.archived);
  // Reviews that need the reviewer: their turn to review, or a plan to approve.
  const waitingOnYou = active.filter((r) => statusOf(r) === "reviewing" || statusOf(r) === "planning").length;
  // Filters offer only the statuses and tags some review has.
  const phases = Object.keys(PHASES).filter((p) => all.some((r) => statusOf(r) === p));
  const tags = Object.keys(TAGS).filter((t) => all.some((r) => r.tag === t));
  // Whose account the top bar shows. A report asks about its own repo; the inbox spans repos, so it asks about the
  // newest review's: the forge account when that host's CLI is logged in, else the repo's git identity.
  let newest = null;
  for (const r of all) {
    const facts = roundFacts(r);
    if (facts?.root) {
      newest = facts;
      break;
    }
  }
  const host = newest?.host ?? "";
  const me = { host, forge: /github/i.test(host) ? "github" : /gitlab/i.test(host) ? "gitlab" : "", root: newest?.root ?? "" };
  const external = `<span class="ext">${icon("external")}</span>`;
  const toolbar = all.length
    ? `<div class="bar"><span class="left"><span id="summary"></span></span><div class="tools">${menu(
        "group",
        "layers",
        "Group",
        choices("group", "Group by", [["owner", "Owner"], ["repo", "Repo"], ["status", "Status"], ["type", "Type"], ["none", "No groups"]]),
      )}${menu("sort", "sort", "Sort", choices("sort", "Sort by", [["activity", "Recent activity"], ["waiting", "Waiting on you first"], ["title", "Title, A to Z"]]))}${menu(
        "filter",
        "filter",
        "Filter",
        `<label class="search">${icon("search")}<input type="text" name="q" placeholder="Search title, repo or branch" aria-label="Search reviews" autocomplete="off" spellcheck="false"></label>${choices("phase", "Status", phases.map((p) => [p, `<span class="dot" style="background:${PHASES[p][1]}"></span>${PHASES[p][0]}`]))}${choices("tag", "Type", tags.map((t) => [t, tagPill(t)]))}<button type="button" class="clear">Clear filters</button>`,
      )}</div></div>`
    : "";
  // The theme the review page saved (pr-report:theme, the same script as viewer/index.html) is applied before the
  // first paint, so the inbox and the review page agree even when the system is set the other way. "system" follows
  // the OS and changes with it, and a theme picked in a review page tab reaches an open inbox through the storage event.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>(()=>{let saved="system";const read=(v)=>{try{saved=JSON.parse(v??'"system"')}catch{saved="system"}};read(localStorage.getItem("pr-report:theme"));const mq=matchMedia("(prefers-color-scheme: dark)");const apply=()=>{document.documentElement.dataset.theme=saved==="dark"||saved==="light"?saved:mq.matches?"dark":"light"};apply();mq.addEventListener("change",apply);addEventListener("storage",(e)=>{if(e.key==="pr-report:theme"){read(e.newValue);apply()}})})()</script>
<title>${waitingOnYou ? `(${waitingOnYou}) ` : ""}Reflektor</title><link rel="icon" href="${inboxIcon(waitingOnYou > 0)}">${FUSE_FILE ? '<link rel="modulepreload" href="/fuse.mjs">' : ""}<style>
${FONT_CSS}
:root{--bg:#fafafa;--surface:#fff;--border:#e4e4e7;--text:#18181b;--muted:#71717a;--faint:#83838c;--lead:#52525b;--accent:#18181b;--hover:color-mix(in srgb,var(--text) 5%,transparent);--hover-2:color-mix(in oklab,oklch(55.2% .016 285.938) 10%,transparent);color-scheme:light}
:root[data-theme=dark]{--bg:#09090b;--surface:#141417;--border:#27272a;--text:#f4f4f5;--muted:#a1a1aa;--faint:#71717a;--lead:#a1a1aa;--accent:#fff;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Geist Variable",ui-sans-serif,system-ui,sans-serif}
.wrap{box-sizing:border-box;max-width:1440px;margin:0 auto;padding-left:16px;padding-right:16px}@media (min-width:640px){.wrap{padding-left:24px;padding-right:24px}}
main{padding-top:32px;padding-bottom:48px}h1{margin:0 0 8px;font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-.025em}p{color:var(--muted);margin:0 0 20px}.lead{max-width:48rem;margin-bottom:24px;color:var(--lead);font-size:15px;line-height:1.625}
.nav{position:sticky;top:0;z-index:30;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg) 85%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}.nav .wrap{display:flex;align-items:center;gap:12px;height:56px}
.brand{display:inline-flex;flex:none;padding:4px;border-radius:2px}.brand:hover{background:var(--hover-2)}.logo{display:inline-flex;height:24px;color:var(--accent)}.logo svg{display:block;height:100%;width:auto}
.grow{flex:1}
.me{margin-left:4px}.who{display:flex;align-items:center;padding:0;border:0;border-radius:50%;background:none;cursor:pointer}.who[aria-expanded=true]{box-shadow:0 0 0 2px color-mix(in oklab,oklch(70.5% .015 286.067) 40%,transparent)}
.face{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border-radius:50%;object-fit:cover;background:color-mix(in oklab,oklch(55.2% .016 285.938) 20%,transparent);color:#fff;font:600 11px/1 "Geist Variable",ui-sans-serif,system-ui,sans-serif}.face.big{width:36px;height:36px;font-size:14px}
.me .menu{box-sizing:border-box;width:288px;font-size:14px}.id{display:flex;align-items:center;gap:12px;padding:8px 10px}.id div{min-width:0}.id b,.id span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.id b{font-weight:500}.id span{color:var(--muted);font-size:12px}
.me hr{height:1px;margin:4px 0;border:0;background:var(--border)}
.mi{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding:8px 10px;border:0;border-radius:2px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}.mi[hidden]{display:none}.mi:hover,.mi:focus-visible{background:var(--hover-2)}.mi>svg{width:16px;height:16px;color:var(--muted)}.mi>span:not(.ext){flex:1}.ext{display:inline-flex;color:var(--faint);opacity:0}.mi:hover .ext,.mi:focus-visible .ext{opacity:1}
.mi kbd{padding:0 6px;border:1px solid var(--border);border-radius:2px;background:var(--hover-2);color:var(--muted);font:12px/1.5 "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace}
.star{display:none;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--border);border-radius:2px;color:inherit;font-size:12px;font-weight:500;line-height:16px;text-decoration:none;white-space:nowrap}.star:hover{background:var(--hover-2)}.star svg{color:var(--muted)}@media (min-width:768px){.star{display:inline-flex}}
iframe.panel{position:fixed;inset:0;z-index:100;width:100%;height:100%;border:0;background:transparent}iframe.panel[hidden]{display:none}
.status{display:flex;align-items:center;gap:8px;padding:8px 10px;color:var(--muted);font-size:12px}.status i{flex:none;width:8px;height:8px;border-radius:50%;background:oklch(69.6% .17 162.48)}.status.down i{background:oklch(63.7% .237 25.331)}
svg{width:14px;height:14px;flex:none}
.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px}#summary{color:var(--muted);font-size:13px}
.only{display:inline-flex;align-items:center;gap:2px;margin-left:10px;padding:1px 2px 1px 9px;border:1px solid var(--border);border-radius:2px;background:var(--surface);font-size:12px}.only a{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:var(--muted);text-decoration:none}.only a:hover{background:var(--hover);color:var(--text)}
.tools{display:flex;gap:6px;flex-wrap:wrap}.dd{position:relative}
.tool{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px 0 10px;border:1px solid var(--border);border-radius:2px;background:var(--surface);color:var(--text);font:500 12px "Geist Variable",ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.tool:hover,.tool[aria-expanded=true]{background:color-mix(in srgb,var(--text) 6%,var(--surface))}.tool>svg{color:var(--muted)}.tool .k{color:var(--muted)}.tool b{font-weight:600}
.tool b:empty{display:none}.badge{background:var(--text);color:var(--bg);border-radius:2px;padding:0 6px;font-size:10px;line-height:16px}
.menu{position:absolute;right:0;top:calc(100% + 6px);z-index:10;min-width:210px;max-width:calc(100vw - 32px);padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:2px;box-shadow:0 12px 32px -12px rgb(0 0 0/.3),0 2px 6px -2px rgb(0 0 0/.12)}
fieldset{border:0;margin:0;padding:0}fieldset+fieldset{margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
legend{float:left;width:100%;box-sizing:border-box;padding:4px 8px;color:var(--muted);font-family:"Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em}
.menu label{clear:both;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:2px;cursor:pointer;font-size:13px;white-space:nowrap}.menu label:hover{background:var(--hover)}
.menu input{margin:0;accent-color:var(--text)}.clear{width:100%;margin-top:6px;padding:6px 8px;border:0;border-top:1px solid var(--border);background:none;color:var(--muted);font:500 12px "Geist Variable",ui-sans-serif,system-ui,sans-serif;text-align:left;cursor:pointer}.clear:hover{color:var(--text)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.menu .search{margin-bottom:6px;padding:0 8px;height:32px;border:1px solid var(--border);border-radius:2px;cursor:text;color:var(--muted)}.menu .search:hover{background:none}.menu .search:focus-within{border-color:var(--muted)}
.search input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--text);font:13px "Geist Variable",ui-sans-serif,system-ui,sans-serif}
.group+.group{margin-top:22px}.gh{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:600}
.gh .av{width:20px;height:20px;border-radius:2px;font-size:9px}.count{color:var(--muted);font:500 12px "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace}
.av.local{background:#71717a}.av.local svg{width:12px;height:12px}
.list{border:1px solid var(--border);background:var(--surface);overflow:hidden}
.row{display:flex;align-items:center;border-top:1px solid var(--border);padding-right:12px}.row:first-child{border-top:0}
.row>a{flex:1;min-width:0;display:flex;gap:12px;align-items:center;padding:12px 16px;color:inherit;text-decoration:none}
.row:hover{background:var(--hover)}
:focus-visible{outline:2px solid var(--text);outline-offset:2px}.row>a:focus-visible{outline-offset:-2px}
.tc{flex:none;width:98px}.tag{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px 0 7px;border-radius:2px;color:#fff;font:600 11px/1 "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.03em;white-space:nowrap}.tag svg{width:12px;height:12px;stroke-width:2.4}
.main{flex:1;min-width:0;display:flex;flex-direction:column}.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta,time{color:var(--muted);font-size:12px}.meta{display:flex;align-items:center;gap:6px;min-width:0}
[data-group=owner] .meta .av,[data-group=owner] .owner,[data-group=repo] .meta .av,[data-group=repo] .repo{display:none}
.av{width:16px;height:16px;flex:none;border-radius:2px;object-fit:cover;display:inline-grid;place-items:center;color:#fff;font:600 8px/1 "Geist Variable",ui-sans-serif,system-ui,sans-serif}.phase{color:color-mix(in oklab,var(--c) 72%,var(--text));font:500 11px "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}time{min-width:64px;text-align:right;white-space:nowrap}
.pr{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px 0 5px;color:color-mix(in oklab,var(--c) 72%,var(--text));border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:2px;font:500 11px/1 "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}.br{font:11.5px "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace}.pr svg{width:11px;height:11px;stroke-width:2.4}
.act{cursor:pointer;font:500 12px "Geist Variable",ui-sans-serif,system-ui,sans-serif;color:var(--muted);background:none;border:1px solid var(--border);border-radius:2px;padding:3px 8px;margin-left:6px;opacity:0}
.row:hover .act,.act:focus-visible,.archived .act{opacity:1}.act:hover{color:var(--text)}.danger:hover{color:#dc2626;border-color:#dc2626}
details{margin-top:28px}summary{cursor:pointer;color:var(--muted);margin-bottom:10px}
@media (max-width:640px){.row>a{display:grid;grid-template-columns:1fr auto auto;gap:6px 10px;padding:12px}.tc{width:auto}.main{grid-column:1/-1;grid-row:2}time{min-width:0}}
.empty{padding:32px;text-align:center;color:var(--muted)}.empty button{margin-left:6px;font:inherit;color:var(--text);background:none;border:0;text-decoration:underline;cursor:pointer}
.intro{padding:44px 24px}.intro h2{margin:0 0 8px;font-size:18px;color:var(--text)}.intro p{max-width:540px;margin:0 auto}
code{font:12.5px "Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hover);border:1px solid var(--border);border-radius:2px;padding:1px 6px;color:var(--text);white-space:nowrap}
.cmds{list-style:none;margin:20px auto 0;padding:0;display:grid;gap:8px;max-width:480px;text-align:left}.cmds li{display:flex;align-items:center;gap:12px}.cmds code{flex:none;min-width:156px;text-align:center}
.hint{border-bottom:1px solid color-mix(in oklab,oklch(60.6% .25 292.717) 30%,transparent);background:oklch(96.9% .016 293.756)}:root[data-theme=dark] .hint{background:color-mix(in oklab,oklch(28.3% .141 291.089) 50%,transparent)}.hint[hidden]{display:none}
.hint .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding-top:8px;padding-bottom:8px}.hint .wrap>svg{width:16px;height:16px;color:oklch(54.1% .281 293.009)}:root[data-theme=dark] .hint .wrap>svg{color:oklch(70.2% .183 293.541)}
.hint a{color:oklch(49.1% .27 292.581);font-weight:500;text-decoration:none;text-underline-offset:2px}.hint a:hover{text-decoration:underline}:root[data-theme=dark] .hint a{color:oklch(81.1% .111 293.571)}
.hint button{display:inline-flex;margin-left:auto;padding:4px;border:0;border-radius:2px;background:none;color:var(--muted);cursor:pointer}.hint button:hover{background:var(--hover-2)}</style></head><body>
<header class="nav"><div class="wrap">${LOGO && `<a class="brand" href="/" title="All reviews" aria-label="All reviews"><span class="logo" aria-hidden="true">${LOGO}</span></a>`}<span class="grow"></span><a class="star" href="https://github.com/bashovski/pr-report" target="_blank" rel="noreferrer">${icon("star")}<span>Star us on GitHub</span></a>
<div class="dd me"><button type="button" class="who" aria-haspopup="true" aria-expanded="false" title="Your account and the daemon" aria-label="Your account and the daemon"><span class="face" id="me-face"></span></button><div class="menu" hidden>
<div class="id"><span class="face big" id="me-face-big"></span><div><b id="me-name">Looking you up…</b><span id="me-sub"></span></div></div><hr>
<a class="mi" id="me-profile" target="_blank" rel="noreferrer" hidden>${icon("user")}<span>Open profile</span>${external}</a>
<button type="button" class="mi" data-panel="settings">${icon("settings")}<span>Settings</span><kbd>?</kbd></button>
<button type="button" class="mi" data-panel="help">${icon("help")}<span>Help</span></button>
<a class="mi" id="me-bug" target="_blank" rel="noreferrer" href="https://github.com/bashovski/pr-report/issues/new">${icon("bug")}<span>Report a bug</span>${external}</a><hr>
<button type="button" class="mi" data-panel="purge">${icon("trash")}<span>Purge daemon cache</span></button><hr>
<div class="status" id="me-status" role="status"><i aria-hidden="true"></i><span></span></div>
</div></div></div></header>
<div class="hint" id="setup-hint" hidden><div class="wrap">${icon("sparkles")}<span>New here? A one-minute setup checks your tools and picks how reports look.</span><a href="/setup">Set up Reflektor</a><button type="button" id="setup-dismiss" title="Not now" aria-label="Not now">${icon("x")}</button></div></div>
<main class="wrap">
<h1>All reviews</h1><p class="lead">Every review on this machine. Open one to comment, ask questions and send it to your agent.</p>
${toolbar}<div id="active" data-rows>${active.length ? `<div class="list">${active.map(inboxRow).join("")}</div>` : `<div class="list">${emptyState(welcome, archived.length)}</div>`}</div>
${archived.length ? `<details><summary>Archived (${archived.length}): finished reviews after 3 quiet days, others after 14</summary><div class="archived" data-rows><div class="list">${archived.map(inboxRow).join("")}</div></div></details>` : ""}
</main>
<script>
// A browser that never saw the setup page (see viewer/src/lib/setup.ts) is offered it once, here and above a report.
try{const hint=document.getElementById("setup-hint");if(!localStorage.getItem("pr-report:setup")){hint.hidden=false;document.getElementById("setup-dismiss").onclick=()=>{localStorage.setItem("pr-report:setup",JSON.stringify({at:new Date().toISOString()}));hint.hidden=true}}}catch{}
const ago=(t)=>{const s=(Date.now()-Date.parse(t))/1000;return s<60?"now":s<3600?Math.round(s/60)+" min ago":s<86400?Math.round(s/3600)+" h ago":Math.round(s/86400)+" d ago"};
for(const el of document.querySelectorAll("time"))el.textContent=ago(el.dataset.at);
const PHASES=${JSON.stringify(PHASES)},TAGS=${JSON.stringify(Object.keys(TAGS))},WAITING=["reviewing","planning"],FOLDER=${JSON.stringify(icon("folder"))};
const LABELS={group:{owner:"Owner",repo:"Repo",status:"Status",type:"Type",none:"None"},sort:{activity:"Recent activity",waiting:"Waiting on you",title:"Title"}};
// Group, sort and filter happen here, on the rows the server sent. The choice is remembered in this browser.
let prefs={group:"owner",sort:"activity",phase:[],tag:[]};
try{const saved=JSON.parse(localStorage.getItem("pr-report-inbox")||"{}");if(LABELS.group[saved.group])prefs.group=saved.group;if(LABELS.sort[saved.sort])prefs.sort=saved.sort;
for(const k of ["phase","tag"])if(Array.isArray(saved[k]))prefs[k]=saved[k]}catch{}
// A saved filter for a status or tag no review has any more would hide everything with nothing to untick.
for(const k of ["phase","tag"]){const offered=[...document.querySelectorAll("input[name="+k+"]")].map((i)=>i.value);prefs[k]=prefs[k].filter((v)=>offered.includes(v))}
const save=()=>{try{localStorage.setItem("pr-report-inbox",JSON.stringify(prefs))}catch{}};
// The search lasts for this tab, through the reloads that new events cause, but not into the next visit.
let query="";try{query=sessionStorage.getItem("pr-report-inbox-q")||""}catch{}
const searchBox=document.querySelector("input[name=q]");if(searchBox)searchBox.value=query;
const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const boxes=[...document.querySelectorAll("[data-rows]")].map((box)=>({box,rows:[...box.querySelectorAll(".row")]}));
const at=(r)=>r.dataset.updated,rank=(list,k)=>{const i=list.indexOf(k);return i<0?list.length:i};
const SORTS={activity:(a,b)=>at(b).localeCompare(at(a)),waiting:(a,b)=>WAITING.includes(b.dataset.phase)-WAITING.includes(a.dataset.phase)||at(b).localeCompare(at(a)),title:(a,b)=>a.dataset.title.localeCompare(b.dataset.title,undefined,{sensitivity:"base"})};
const KEYS={owner:(r)=>r.dataset.owner,repo:(r)=>r.dataset.repo,status:(r)=>r.dataset.phase,type:(r)=>r.dataset.tag,none:()=>""};
const nameOf=(k)=>prefs.group==="owner"&&!k?"Local repos":k;
// Fuzzy search with Fuse.js over title, repo and branch. Until it loads, or if it cannot, a plain substring match.
const items=boxes.flatMap((b)=>b.rows).map((row)=>({row,title:row.dataset.title,repo:row.dataset.repo,branch:row.dataset.branch}));
let fuse=null,hits=null;
const search=()=>{const q=query.trim();hits=!q?null:new Set(fuse?fuse.search(q).map((x)=>x.item.row):items.filter((i)=>(i.title+" "+i.repo+" "+i.branch).toLowerCase().includes(q.toLowerCase())).map((i)=>i.row))};
// "View All Reports for <owner>" on a review page links here with ?owner=, to show only that owner's reviews.
const onlyOwner=new URLSearchParams(location.search).get("owner");
const left=document.querySelector(".bar .left");
// It starts a fresh look at that owner, so a search left from earlier in this tab does not hide their reviews.
if(onlyOwner!==null){query="";try{sessionStorage.removeItem("pr-report-inbox-q")}catch{}if(searchBox)searchBox.value=""}
if(onlyOwner!==null&&left){const chip=make("span","only","Owner: "+(onlyOwner||"Local repos")),x=make("a","","\u00d7");x.href="/";x.title="Show every owner";x.setAttribute("aria-label","Show every owner");chip.append(x);left.append(chip)}
const matches=(r)=>(onlyOwner===null||r.dataset.owner===onlyOwner)&&(!prefs.phase.length||prefs.phase.includes(r.dataset.phase))&&(!prefs.tag.length||prefs.tag.includes(r.dataset.tag))&&(!hits||hits.has(r));
function heading(key,first,count){
  const h=make("h2","gh");
  if(prefs.group==="owner"||prefs.group==="repo"){
    let av=first.querySelector(".av")?.cloneNode(true);
    if(prefs.group==="owner"&&!key){av=make("span","av local");av.innerHTML=FOLDER}
    if(av)h.append(av);h.append(make("span","",nameOf(key)));
  }else if(prefs.group==="status"){const dot=make("span","dot");dot.style.background=(PHASES[key]??[])[1]??"#71717a";h.append(dot,(PHASES[key]??[key])[0])}
  else h.append(first.querySelector(".tag").cloneNode(true));
  h.append(make("span","count",String(count)));return h;
}
function render(){
  document.body.dataset.group=prefs.group;
  for(const {box,rows} of boxes){
    if(!rows.length)continue;
    const kept=rows.filter(matches).sort(SORTS[prefs.sort]),groups=new Map();
    for(const r of kept){const k=KEYS[prefs.group](r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)}
    const order=[...groups.keys()];
    if(prefs.group==="status")order.sort((a,b)=>rank(Object.keys(PHASES),a)-rank(Object.keys(PHASES),b));
    else if(prefs.group==="type")order.sort((a,b)=>rank(TAGS,a)-rank(TAGS,b));
    else if(prefs.sort==="title")order.sort((a,b)=>nameOf(a).localeCompare(nameOf(b),undefined,{sensitivity:"base"}));
    box.replaceChildren(...order.map((k)=>{const section=make("section","group"),list=make("div","list");if(prefs.group!=="none")section.append(heading(k,groups.get(k)[0],groups.get(k).length));list.append(...groups.get(k));section.append(list);return section}));
    if(!kept.length){const list=make("div","list"),empty=make("div","empty","No reviews match these filters."),clear=make("button","clear-all","Clear filters");clear.type="button";empty.append(clear);list.append(empty);box.append(list)}
  }
  const active=boxes[0].rows,visible=active.filter(matches),shown=visible.length,waiting=visible.filter((r)=>WAITING.includes(r.dataset.phase)).length;
  const summary=document.getElementById("summary");
  if(summary)summary.textContent=(shown===active.length?active.length+" "+(active.length===1?"review":"reviews"):shown+" of "+active.length+" reviews")+(waiting?", "+waiting+" waiting on you":"");
  for(const i of document.querySelectorAll(".menu input[type=radio],.menu input[type=checkbox]"))i.checked=i.type==="radio"?prefs[i.name]===i.value:prefs[i.name].includes(i.value);
  for(const k of ["group","sort"]){const b=document.querySelector("[data-label="+k+"]");if(b)b.textContent=LABELS[k][prefs[k]]}
  const n=prefs.phase.length+prefs.tag.length+(query.trim()?1:0),f=document.querySelector("[data-label=filter]");
  if(f){f.textContent=n?String(n):"";f.className=n?"badge":""}
}
search();render();
import("/fuse.mjs").then(({default:Fuse})=>{fuse=new Fuse(items,{keys:[{name:"title",weight:2},"repo","branch"],threshold:0.35,ignoreLocation:true});search();render()}).catch(()=>{});
const setQuery=(q)=>{query=q;try{sessionStorage.setItem("pr-report-inbox-q",q)}catch{}search();render()};
document.addEventListener("input",(e)=>{if(e.target===searchBox)setQuery(searchBox.value)});
// Menus: one open at a time; a click outside or Escape closes them.
const dds=[...document.querySelectorAll(".dd")],openMenu=()=>dds.find((d)=>!d.querySelector(".menu").hidden);
const toggle=(dd,open)=>{dd.querySelector(".menu").hidden=!open;dd.querySelector("[aria-haspopup]").setAttribute("aria-expanded",String(open));if(open&&dd.contains(searchBox))searchBox.focus()};
let reloadLater=false;
document.addEventListener("click",(e)=>{
  const dd=e.target.closest(".dd");for(const d of dds)if(d!==dd)toggle(d,false);
  if(dd&&e.target.closest("[aria-haspopup]"))toggle(dd,dd.querySelector(".menu").hidden);
  if(e.target.closest(".clear,.clear-all")){prefs.phase=[];prefs.tag=[];save();if(searchBox)searchBox.value="";setQuery("")}
  if(reloadLater&&!openMenu())location.reload();
});
// "/" opens the filter menu at the search box, as on GitHub.
document.addEventListener("keydown",(e)=>{if(e.key!=="/"||e.metaKey||e.ctrlKey||e.altKey||e.target.closest("input,textarea")||!searchBox)return;e.preventDefault();for(const d of dds)toggle(d,d.contains(searchBox))});
document.addEventListener("keydown",(e)=>{const d=openMenu();if(e.key==="Escape"&&d){toggle(d,false);d.querySelector("[aria-haspopup]").focus();if(reloadLater)location.reload()}});
document.addEventListener("change",(e)=>{const i=e.target;if(!(i.name in prefs))return;
  if(i.type==="radio"){prefs[i.name]=i.value;toggle(i.closest(".dd"),false)}else prefs[i.name]=[...document.querySelectorAll("input[name="+i.name+"]:checked")].map((x)=>x.value);
  save();render()});
// The stream starts with every review's current state, so reload only for a review that changed or is new.
const shown=${JSON.stringify(Object.fromEntries(all.map((r) => [r.id, r.updatedAt]))).replace(/</g, "\\u003c")};
const es=new EventSource("/api/events?token=${pageToken}&watch=*");let t;
es.addEventListener("state",(e)=>{const s=JSON.parse(e.data);if(shown[s.id]===s.updatedAt)return;clearTimeout(t);t=setTimeout(()=>openMenu()?(reloadLater=true):location.reload(),400)});
document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-act]");if(!b)return;
if(b.dataset.act==="delete"&&!confirm("Delete this review's files ("+b.dataset.size+") and its saved rounds? This cannot be undone. Your code and branches are not touched."))return;
const act=b.dataset.act==="delete"?"delete":"archive";
const res=await fetch("/api/r/"+encodeURIComponent(b.dataset.id)+"/"+act,{method:"POST",headers:{"x-review-token":"${pageToken}","content-type":"application/json"},body:JSON.stringify({archived:b.dataset.act!=="restore"})});
if(!res.ok)alert((await res.json().catch(()=>({}))).error||"Could not do that");location.reload()});
// The reader's menu in the top bar, with the options a report's menu has (viewer/src/components/UserMenu.tsx): who is
// reading, the profile, Settings, Help, a bug report, the cache purge and the daemon. A change to one menu needs the
// same change to the other.
const ME=${JSON.stringify(me).replace(/</g, "\\u003c")},DAEMON=${JSON.stringify({ version: VERSION, node: process.version, startedAt })};
const SOURCES={gh:"via the GitHub CLI",glab:"via the GitLab CLI",git:"from git config",none:"no identity found"};
const paint=(el,a)=>{if(!a)return;if(String(a.image||"").startsWith("data:image/")){const i=new Image();i.src=a.image;i.alt="";i.className=el.className;el.replaceWith(i);return}el.style.background=/^#[0-9a-f]{6}$/i.test(a.color||"")?a.color:"#71717a";el.textContent=String(a.initials||"").slice(0,2)};
fetch("/api/me?"+new URLSearchParams(ME),{headers:{"x-review-token":"${pageToken}"}}).then((r)=>r.ok?r.json():null).catch(()=>null).then((who)=>{
  const name=document.getElementById("me-name");
  if(!who){name.textContent="Unknown";return}
  name.textContent=who.name||who.login||who.email||"Unknown";
  document.getElementById("me-sub").textContent=(who.login?"@"+who.login:who.email||"")+(who.login||who.email?" · ":"")+SOURCES[who.source];
  for(const id of ["me-face","me-face-big"])paint(document.getElementById(id),who.avatar);
  if(who.url){const p=document.getElementById("me-profile"),forge={github:"GitHub ",gitlab:"GitLab "}[ME.forge]||"";p.href=who.url;p.querySelector("span").textContent="Open "+forge+"profile";p.hidden=false}
});
document.getElementById("me-bug").href+="?"+new URLSearchParams({body:["<"+"!-- What happened, and what you expected --"+">","","","---","Reflektor daemon "+DAEMON.version+", Node "+DAEMON.node,"Browser: "+navigator.userAgent].join("\\n")});
// Settings, Help and the cache purge are the report's own dialogs. They are not written a second time here: the page
// at /panel holds them, and it is loaded in a see-through frame over the window (viewer/src/lib/panel.ts). The frame
// is fetched when the menu first opens, so a dialog is there at once when it is asked for. A theme picked in Settings
// reaches this page through the storage event the script in the head listens to.
let panel=null,panelReady=false,wanted=null;
const loadPanel=()=>{if(panel)return;panel=document.createElement("iframe");panel.className="panel";panel.title="Settings, help and the cache";panel.hidden=true;panel.src="/panel";document.body.append(panel)};
const showPanel=()=>{if(!panelReady||!wanted)return;panel.hidden=false;panel.contentWindow.postMessage({open:wanted},location.origin);panel.focus()};
const openPanel=(name)=>{wanted=name;loadPanel();showPanel()};
addEventListener("message",(e)=>{if(!panel||e.origin!==location.origin||e.source!==panel.contentWindow||!e.data)return;
  if(e.data.panel==="ready"){panelReady=true;showPanel()}
  if(e.data.panel==="closed"&&!panel.hidden){panel.hidden=true;wanted=null;document.querySelector(".who").focus()}});
document.querySelector(".who").addEventListener("click",loadPanel);
document.addEventListener("click",(e)=>{const b=e.target.closest("[data-panel]");if(!b)return;toggle(b.closest(".dd"),false);openPanel(b.dataset.panel)});
// "?" opens Settings, as in a report.
document.addEventListener("keydown",(e)=>{if(e.key!=="?"||e.metaKey||e.ctrlKey||e.altKey||e.target.closest("input,textarea"))return;e.preventDefault();openPanel("settings")});
// How long the daemon has run, worded as in the report's menu: its two largest units, never rounded up.
const upFor=(since)=>{const s=(Date.now()-Date.parse(since))/1000;if(s<90)return "just started";const m=Math.floor(s/60),d=Math.floor(m/1440),h=Math.floor(m%1440/60),min=m%60;return "up "+(d?[d+"d",h>0&&h+"h"]:h?[h+"h",min>0&&min+"min"]:[min+"min"]).filter(Boolean).join(" ")};
const status=document.getElementById("me-status");let daemonUp=true;
const showStatus=()=>{status.classList.toggle("down",!daemonUp);status.lastElementChild.textContent=daemonUp?"Daemon up · "+DAEMON.version.slice(0,7)+" · "+upFor(DAEMON.startedAt):"Daemon unavailable"};
showStatus();es.addEventListener("open",()=>{daemonUp=true;showStatus()});es.addEventListener("error",()=>{daemonUp=false;showStatus()});
document.querySelector(".who").addEventListener("click",showStatus);
</script></body></html>`;
}

// The viewer's app build. Every review page is the same app; it loads its round's data from the API.
const here = dirname(fileURLToPath(import.meta.url));
// The Reflektor mark, the same file the review page draws. Its letter takes the text color, so it is put into the
// page as SVG. Without the file the inbox simply has no mark.
const LOGO_FILE = join(here, "../brand/reflektor-logo.svg");
const LOGO = existsSync(LOGO_FILE) ? readFileSync(LOGO_FILE, "utf8").trim() : "";
const APP_DIR = [join(here, "../assets/app"), join(here, "../../viewer/dist/app")].find((d) => existsSync(join(d, "index.html")));
// Fuse.js for the inbox search: copied next to the app by install.mjs, or read from the viewer's
// packages in a checkout that is not built. Without it the inbox falls back to a plain substring match.
const FUSE_FILE = [join(here, "../assets/fuse.mjs"), join(here, "../../viewer/node_modules/fuse.js/dist/fuse.basic.min.mjs")].find((f) => existsSync(f));

// The inbox uses the page's fonts, Geist and Geist Mono, from the font files in the viewer build; without a build it
// falls back to the system fonts the way it always did.
const FONT_CSS = (() => {
  const dir = APP_DIR && join(APP_DIR, "assets");
  const files = dir && existsSync(dir) ? readdirSync(dir) : [];
  const face = (family, prefix) => {
    const file = files.find((f) => f.startsWith(prefix) && f.endsWith(".woff2"));
    return file ? `@font-face{font-family:"${family}";src:url(/app/assets/${file}) format("woff2");font-weight:100 900;font-display:swap}` : "";
  };
  return face("Geist Variable", "geist-latin-wght-normal-") + face("Geist Mono Variable", "geist-mono-latin-wght-normal-");
})();
const ASSET_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// What an inbox without open reviews shows: how to start, and a greeting when the setup page sent
// the reader here. Once reviews exist, an empty inbox only points at the archive.
function emptyState(welcome, archivedCount) {
  if (archivedCount) return '<div class="empty">Nothing open. The archived reviews are below.</div>';
  return `<div class="empty intro"><h2>${welcome ? "You're all set" : "No reviews yet"}</h2>
<p>Open your coding agent in a repo, on a branch with changes, and ask it for a PR report. In Claude Code, type <code>/pr-report</code>. The report opens in a new tab, and every review on this machine shows up here.</p>
<ul class="cmds"><li><code>/pr-report</code><span>compare with the PR base or the default branch</span></li><li><code>/pr-report develop</code><span>compare with another branch</span></li><li><code>/pr-report resume</code><span>pick a review up in a new Claude Code session</span></li></ul></div>`;
}

// First-run setup: the viewer at /setup, with the page token so it can ask the daemon about the
// tools on this machine. The installer opens it after an install.
function setupPage() {
  return readFileSync(join(APP_DIR, "index.html"), "utf8")
    .replace("<title>PR report</title>", () => "<title>Set up Reflektor</title>")
    .replace("</head>", () => `<script>window.__PR_SETUP__=${JSON.stringify({ token: pageToken })}</script></head>`);
}

// The report's own dialogs (Settings, Help, the cache purge) for the inbox, which is not built with the viewer and
// shows this page in a frame over itself. See viewer/src/lib/panel.ts.
function panelPage() {
  return readFileSync(join(APP_DIR, "index.html"), "utf8")
    .replace("<title>PR report</title>", () => "<title>Reflektor</title>")
    .replace("</head>", () => `<script>window.__PR_PANEL__=${JSON.stringify({ token: pageToken })}</script></head>`);
}

function reviewPage(r, round) {
  const entry = r.rounds.find((x) => x.round === round) ?? r.rounds.at(-1);
  if (!entry || !existsSync(roundFile(entry))) return null;
  const config = { live: true, id: r.id, round: entry.round, token: pageToken, api: `/api/r/${encodeURIComponent(r.id)}`, agent: r.agent ?? null };
  // The page's base title (see viewer/src/lib/tab.ts), so the tab is right before the report loads.
  const title = `${r.branch} · ${r.repo.split("/").at(-1)}${entry.round > 1 ? ` · round ${entry.round}` : ""}`;
  return readFileSync(join(APP_DIR, "index.html"), "utf8")
    .replace("<title>PR report</title>", () => `<title>${escapeHtml(title)}</title>`)
    .replace("</head>", () => `<script>window.__PR_REVIEW__=${JSON.stringify(config)}</script></head>`);
}

// Vite puts a content hash in every asset name, so the browser can keep each one for good.
function sendAsset(res, parts) {
  const file = resolve(APP_DIR, ...parts);
  if (!file.startsWith(APP_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
  res.writeHead(200, {
    "content-type": ASSET_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(file));
}

// ------------------------------------------------------------------ drift
// Reviews on screen are checked every 15 seconds for code that changed after their report was built:
// new commits, edits, new files. The page then says the report may be out of date. Not while the agent
// works on the round, since then the code is meant to change.

const DRIFT_MS = Number(process.env.PR_REPORT_DRIFT_SECONDS ?? 15) * 1000;
const run = promisify(execFile);
const gitIn = (cwd, args, env) =>
  // windowsHide: the daemon has no console on Windows, so each git call would flash a window.
  run("git", ["-c", "core.quotePath=false", ...args], { cwd, env: env ?? process.env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }).then((x) => x.stdout.trim(), () => null);

// ------------------------------------------------------------------ tools on this machine

// The setup page asks which of the GitHub and GitLab command lines are installed and logged in.
// Each answer is two fixed commands with a short timeout; nothing from the request reaches them.
// The answer is kept for two seconds, since several tabs may ask at once.
const tool = async (cmd, args) => {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 8000, windowsHide: true, env: process.env });
    return { ok: true, text: `${stdout}\n${stderr}` };
  } catch (e) {
    return { ok: false, text: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
};
async function toolState(cmd, accountPattern) {
  const version = await tool(cmd, ["--version"]);
  if (!version.ok) return { installed: false, version: null, loggedIn: false, account: null, host: null };
  // "gh version 2.92.0 (2026-04-28)", "glab 1.50.0 (2025-01-01)".
  const number = version.text.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  // "auth status" exits 0 only when logged in. Its text names the host on a line of its own and the
  // account on the "Logged in" line.
  const auth = await tool(cmd, ["auth", "status"]);
  const host = auth.text.match(/^\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$/im)?.[1] ?? null;
  const account = auth.text.match(accountPattern)?.[1] ?? null;
  return { installed: true, version: number, loggedIn: auth.ok, account, host };
}
let toolsCache = null;
async function toolsReport() {
  if (toolsCache && Date.now() - toolsCache.at < 2000) return toolsCache.report;
  const [gh, glab] = await Promise.all([toolState("gh", /Logged in to \S+ account (\S+)/), toolState("glab", /Logged in to \S+ as (\S+)/)]);
  const report = { gh, glab, checkedAt: now() };
  toolsCache = { at: Date.now(), report };
  return report;
}

// The repo and the code a round was built from, read once from its data file.
function roundFacts(r) {
  const entry = r.rounds.find((x) => x.round === r.round);
  if (!entry) return null;
  if (r.facts?.builtAt === entry.builtAt) return r.facts;
  try {
    const { diff } = JSON.parse(roundText(roundFile(entry)));
    r.facts = {
      builtAt: entry.builtAt,
      root: diff.repo.root,
      gitDir: diff.repo.gitDir,
      branch: diff.branch.head,
      headSha: diff.branch.headSha,
      snapshot: diff.branch.snapshot,
      // Where the branch's pull request would live, and whether the branch is on the remote at all.
      host: diff.repo.host ?? null,
      owner: diff.repo.owner ?? null,
      name: diff.repo.name,
      upstream: diff.branch.upstream ?? null,
    };
  } catch {
    r.facts = { builtAt: entry.builtAt, root: null };
  }
  return r.facts;
}

// The working tree as a git tree, untracked files included, without touching the real index.
async function workingTree(f) {
  const index = join(f.gitDir, "pr-report", "drift.index");
  try {
    if (existsSync(join(f.gitDir, "index"))) copyFileSync(join(f.gitDir, "index"), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if ((await gitIn(f.root, ["add", "-A"], env)) === null) return null;
    return await gitIn(f.root, ["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
  }
}

async function checkDrift(r) {
  const f = roundFacts(r);
  if (!f?.root || !existsSync(f.root) || r.checkingDrift) return;
  r.checkingDrift = true;
  try {
    const [tree, head, branch] = await Promise.all([workingTree(f), gitIn(f.root, ["rev-parse", "HEAD"]), gitIn(f.root, ["rev-parse", "--abbrev-ref", "HEAD"])]);
    if (!tree || !head) return;
    const files = ((await gitIn(f.root, ["diff", "--name-only", f.snapshot, tree])) ?? "").split("\n").filter(Boolean);
    const commits = head === f.headSha ? 0 : Number(await gitIn(f.root, ["rev-list", "--count", `${f.headSha}..${head}`])) || 0;
    const drift = files.length || branch !== f.branch ? { files: files.slice(0, 50), fileCount: files.length, commits, branch: branch !== f.branch ? branch : null } : null;
    if (JSON.stringify(drift) !== JSON.stringify(r.drift ?? null)) {
      r.drift = drift;
      broadcast(r);
    }
  } finally {
    r.checkingDrift = false;
  }
}

setInterval(() => {
  for (const r of reviews.values()) {
    if (openTabs(r) === 0) continue;
    if (r.phase === "reviewing" || r.phase === "done") void checkDrift(r);
    // Not awaited: a slow network must not hold up the git check.
    void checkPr(r);
  }
}, DRIFT_MS).unref();

// ------------------------------------------------------------------ pull request
// The branch's pull request on GitHub, followed while the review is on screen, so a pull request
// opened, merged or closed after the report was built shows up without a new report. The agent tells
// the daemon the moment it opens one (review.mjs pr); for what happens on GitHub afterwards the
// daemon polls with conditional requests. GitHub allows 5,000 requests an hour per token, and a 304
// Not Modified answer to a request with If-None-Match does not count, so following an idle pull
// request costs nothing: one request per review when something changed, headers only otherwise.

const PR_POLL_MS = Number(process.env.PR_REPORT_PR_POLL_SECONDS ?? 60) * 1000;
// Overridden by the check suites, which point the daemon at a local stand-in for GitHub.
const GITHUB_API = (process.env.PR_REPORT_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
const PR_QUIET_MS = 30 * 60_000;

// The token comes from gh once per daemon start and stays in memory: never on disk or in the log.
// Without one (logged out) the daemon asks gh itself for the pull request; without gh it does not poll.
let githubAuth = null;
const githubToken = () =>
  (githubAuth ??= process.env.PR_REPORT_GITHUB_TOKEN
    ? Promise.resolve({ token: process.env.PR_REPORT_GITHUB_TOKEN, gh: true })
    : run("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 }).then(
        (x) => ({ token: x.stdout.trim() || null, gh: true }),
        (e) => ({ token: null, gh: e.code !== "ENOENT" }),
      ));

// One shape for a pull request from the REST API (snake_case) and from gh (camelCase).
const prFrom = (p, checkedAt = now()) => ({
  number: Number(p.number),
  url: p.html_url ?? p.url,
  title: p.title ?? null,
  state: p.merged_at || p.mergedAt || p.state === "MERGED" ? "MERGED" : String(p.state).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
  base: p.base?.ref ?? p.baseRefName ?? null,
  mergedAt: p.merged_at ?? p.mergedAt ?? null,
  checkedAt,
});

// The error for an answer that is not 2xx or 304. A rate limit says when to try again.
function githubError(res) {
  const e = new Error(`GitHub answered ${res.status}`);
  e.status = res.status;
  if (res.status === 403 || res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    e.retryAfterMs = after ? after * 1000 : reset ? Math.max(1000, reset * 1000 - Date.now()) : undefined;
  }
  return e;
}

const githubGet = (path, token, etag) =>
  fetch(`${GITHUB_API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pr-report",
      ...(etag ? { "if-none-match": etag } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

// The newest pull request from this branch, through the REST API. Returns undefined when nothing
// changed since the last look (304), null when the branch has none, else the pull request.
async function restPr(r, f, token) {
  const query = new URLSearchParams({ head: `${f.owner}:${f.branch}`, state: "all", per_page: "1" });
  const res = await githubGet(`/repos/${f.owner}/${f.name}/pulls?${query}`, token, r.prEtag);
  if (res.status === 304) return undefined;
  if (res.status === 401) {
    // The token no longer works: from here on ask gh, which may have a fresh one.
    githubAuth = Promise.resolve({ token: null, gh: true });
    throw githubError(res);
  }
  if (!res.ok) throw githubError(res);
  r.prEtag = res.headers.get("etag");
  const [pr] = await res.json();
  return pr ? prFrom(pr) : null;
}

// The pull request through gh, for a daemon without a token. `ref` is the branch or the pull request's URL.
const ghPr = (cwd, ref) =>
  run("gh", ["pr", "view", ref, "--json", "number,url,title,state,mergedAt,baseRefName"], { cwd, windowsHide: true, timeout: 15_000 }).then(
    (x) => prFrom(JSON.parse(x.stdout)),
    (e) => {
      if (/no pull requests found/i.test(e.stderr ?? "")) return null;
      throw e;
    },
  );

// Keeps what GitHub said, and tells open pages and the inbox when it differs from what they show.
function setPr(r, pr) {
  // A pull request does not go away. An empty answer with one known means the lookup missed it
  // (a pull request into another repo, from a fork), so the known one stays.
  if (!pr) return false;
  const shown = r.pr && JSON.stringify([r.pr.number, r.pr.state, r.pr.title, r.pr.mergedAt, r.pr.base]);
  if (shown === JSON.stringify([pr.number, pr.state, pr.title, pr.mergedAt, pr.base])) {
    r.pr.checkedAt = pr.checkedAt;
    return false;
  }
  r.pr = pr;
  save(r);
  return true;
}

// A report built after the pull request exists starts with its state. A state the daemon saw since
// (a merge) wins over an older build.
function seedPr(r, bundle) {
  const frozen = bundle.diff.branch.pr;
  if (!frozen || (r.pr && r.pr.checkedAt > bundle.builtAt)) return;
  setPr(r, { number: Number(frozen.number), url: frozen.url, title: frozen.title ?? null, state: frozen.state ?? "OPEN", base: bundle.diff.branch.base, mergedAt: null, checkedAt: bundle.builtAt });
}

// One look at GitHub for a review on screen, when it is due. Every PR_POLL_MS, or every tick while
// the branch is on the remote without a pull request, since one is likely about to be opened.
// Nothing more once it is merged. On failure it backs off, as far as GitHub says when rate limited,
// doubling otherwise (offline, logged out) until it goes quiet.
async function checkPr(r) {
  const f = roundFacts(r);
  if (f?.host !== "github.com" || !f.owner || f.branch === "HEAD") return;
  if (r.pr?.state === "MERGED" || r.prBusy || Date.now() < (r.prNextAt ?? 0)) return;
  r.prBusy = true;
  try {
    const auth = await githubToken();
    if (!auth.token && !auth.gh) {
      r.prNextAt = Infinity;
      return;
    }
    const found = auth.token ? await restPr(r, f, auth.token) : await ghPr(existsSync(f.root ?? "") ? f.root : undefined, f.branch);
    r.prFailures = 0;
    if (found !== undefined) setPr(r, found);
    r.prNextAt = Date.now() + (!r.pr && f.upstream ? 0 : PR_POLL_MS);
  } catch (e) {
    r.prFailures = (r.prFailures ?? 0) + 1;
    r.prNextAt = Date.now() + (e.retryAfterMs ?? Math.min(PR_POLL_MS * 2 ** r.prFailures, PR_QUIET_MS));
  } finally {
    r.prBusy = false;
  }
}

// ------------------------------------------------------------------ archive
// The inbox keeps reviews in use. Finished ones move to "Archived" after 3 quiet days, others after
// 14; the reviewer can archive and restore by hand. Only an archived review can be deleted, which
// removes its files and its git refs.

const DAY = 86_400_000;
function archiveIdle() {
  let changed = false;
  for (const r of reviews.values()) {
    const quiet = Date.now() - Date.parse(r.updatedAt);
    const finished = statusOf(r) === "done" || statusOf(r) === "merged";
    if (!r.archived && (quiet > 14 * DAY || (finished && quiet > 3 * DAY))) {
      r.archived = now();
      changed = true;
    }
  }
  if (changed) saveRegistry();
}
archiveIdle();
setInterval(archiveIdle, 3_600_000).unref();

// A branch's own folder goes whole. A folder shared by older reviews keeps what may belong to others.
const ownFolder = (r) => basename(r.dir) !== "pr-report";
function reviewFiles(r) {
  if (ownFolder(r)) return existsSync(r.dir) ? readdirSync(r.dir).map((f) => join(r.dir, f)) : [];
  const rounds = r.rounds.map((x) => x.round);
  return [
    ...r.rounds.flatMap((x) => [roundFile(x), roundFile(x).replace(/\.json$/, ".html")]),
    ...rounds.flatMap((n) => [reviewFile(r, n), questionsFile(r, n)]),
    stateFile(r),
    draftFile(r),
  ].filter((f, i, all) => all.indexOf(f) === i && existsSync(f));
}
const sizeOf = (r) => reviewFiles(r).reduce((n, f) => n + statSync(f).size, 0);

async function deleteReview(r) {
  const f = roundFacts(r);
  if (f?.root && existsSync(f.root)) {
    const prefix = `refs/pr-report/rounds/${r.branch.replace(/[^\w.-]+/g, "-")}/`;
    const refs = ((await gitIn(f.root, ["for-each-ref", "--format=%(refname)", prefix])) ?? "").split("\n").filter(Boolean);
    for (const ref of refs) await gitIn(f.root, ["update-ref", "-d", ref]);
  }
  if (ownFolder(r)) rmSync(r.dir, { recursive: true, force: true });
  else for (const file of reviewFiles(r)) rmSync(file, { force: true });
  reviews.delete(r.id);
  saveRegistry();
}

// ------------------------------------------------------------------ routes

let lastActivity = Date.now();

async function handle(req, res, port) {
  const host = String(req.headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "wrong host" });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return send(res, 403, { error: "wrong origin" });

  const url = new URL(req.url ?? "/", `http://${host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!url.pathname.endsWith("/next-event")) lastActivity = Date.now();

  if (req.method === "GET" && url.pathname === "/") return send(res, 200, inboxPage(url.searchParams.has("welcome")), "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/fuse.mjs") {
    if (!FUSE_FILE) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
    return res.end(readFileSync(FUSE_FILE));
  }
  if (["r", "app", "setup", "panel"].includes(parts[0]) && !APP_DIR) return send(res, 500, "The viewer is not built. Run pnpm build in the pr-report checkout.", "text/plain");
  if (req.method === "GET" && parts[0] === "app" && parts[1] === "assets") return sendAsset(res, parts.slice(1));
  if (req.method === "GET" && url.pathname === "/setup") return send(res, 200, setupPage(), "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/panel") return send(res, 200, panelPage(), "text/html; charset=utf-8", { framedByOwnPages: true });
  if (req.method === "GET" && parts[0] === "r" && parts[1]) {
    const r = reviews.get(parts[1]);
    const html = r && reviewPage(r, Number(url.searchParams.get("round")) || r.round);
    return html ? send(res, 200, html, "text/html; charset=utf-8") : send(res, 404, "Review not found", "text/plain");
  }

  if (parts[0] !== "api") return send(res, 404, { error: "not found" });

  // ---------- setup page: the tools on this machine, page token
  if (req.method === "GET" && parts[1] === "setup" && parts[2] === "tools") {
    if (!same(req.headers["x-review-token"], pageToken)) return send(res, 401, { error: "bad token" });
    return send(res, 200, await toolsReport());
  }

  // ---------- agent API (review.mjs), admin token
  const admin = same(req.headers["x-admin-token"], adminToken);
  if (parts[1] === "health") return admin ? send(res, 200, { ok: true, version: VERSION, pid: process.pid }) : send(res, 401, { error: "bad token" });
  if (parts[1] === "shutdown" && admin) {
    // Open pages hear that the daemon is being replaced, so they say "restarting" instead of "unavailable".
    for (const stream of streams) sse(stream, "shutdown", { version: VERSION });
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // ---------- page stream: one connection can watch many reviews
  if (req.method === "GET" && parts[1] === "events") {
    if (!same(url.searchParams.get("token"), pageToken)) return send(res, 401, { error: "bad token" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const watch = url.searchParams.get("watch") ?? "*";
    res.watchAll = watch === "*";
    res.watching = new Set(res.watchAll ? [] : watch.split(","));
    streams.add(res);
    for (const r of reviews.values()) if (watches(res, r.id)) sse(res, "state", liveState(r));
    // After the states: a reader of the first chunk still finds a review's state first.
    sse(res, "daemon", daemonInfo());
    req.on("close", () => streams.delete(res));
    return;
  }

  // ---------- page API without a review: who is reading, and the daemon's cache
  if (parts[1] === "me" || parts[1] === "cache") {
    if (!same(req.headers["x-review-token"], pageToken)) return send(res, 401, { error: "bad token" });
    if (req.method === "GET" && parts[1] === "me") {
      const who = await whoAmI({ host: url.searchParams.get("host") || null, forge: url.searchParams.get("forge") || null, root: url.searchParams.get("root") || null });
      return send(res, 200, who);
    }
    if (req.method === "POST" && parts[1] === "cache" && parts[2] === "purge") return send(res, 200, { ok: true, removed: purgeCache() });
    return send(res, 404, { error: "not found" });
  }

  if (parts[1] === "reviews" && req.method === "GET") {
    if (!admin) return send(res, 401, { error: "bad token" });
    return send(res, 200, { reviews: [...reviews.values()].map((r) => ({ ...liveState(r), dir: r.dir, url: `http://127.0.0.1:${port}/r/${r.id}` })) });
  }

  // Register a report, or publish a new round of an existing review.
  if (parts[1] === "reviews" && req.method === "POST") {
    if (!admin) return send(res, 401, { error: "bad token" });
    const { report: file } = JSON.parse(await readBody(req));
    if (!file || !existsSync(file)) return send(res, 400, { error: "report file not found" });
    const raw = roundText(file);
    if (!raw || !raw.startsWith("{")) return send(res, 400, { error: "the report has no data; build it with build.mjs" });
    const bundle = JSON.parse(raw);
    const dir = dirname(file);
    const repo = [bundle.diff.repo.owner, bundle.diff.repo.name].filter(Boolean).join("/");
    const branch = bundle.diff.branch.head;
    let r = [...reviews.values()].find((x) => x.dir === dir && x.branch === branch);
    if (!r) {
      const id = `${slug(bundle.diff.repo.name)}-${slug(branch)}-${createHash("sha1").update(dir).digest("hex").slice(0, 4)}`;
      r = { id, dir, repo, branch, rounds: [], phase: "reviewing", statuses: {}, plan: null, pr: null, events: [], lastAgentActivity: null, questions: [], round: bundle.round };
      reviews.set(id, r);
    }
    r.title = bundle.report.title;
    r.tag = bundle.report.tag;
    r.archived = null;
    r.avatar = bundle.diff.repo.avatar ?? null;
    r.checksFile = bundle.projectChecks?.file ?? join(dir, "checks.json");
    r.checks = readChecksRun(r.checksFile);
    const round = bundle.round ?? r.round;
    // Publishing a round again (a rebuild, or an agent reconnecting) only swaps its data file.
    // Comments, plan and progress belong to the round and stay.
    const republished = r.rounds.some((x) => x.round === round);
    r.rounds = [...r.rounds.filter((x) => x.round !== round), { round, file, builtAt: bundle.builtAt, publishedAt: now() }].sort((a, b) => a.round - b.round);
    // A new build matches the code again; a rebuild answers the reviewer's request for one.
    r.drift = null;
    markHandled(r, "refresh");
    seedPr(r, bundle);
    // Who published: the caller says so. Failing that, the build names the agent that made it.
    noteAgent(r, req);
    r.agent ??= cleanAgent(bundle.agent);
    if (!republished && round !== r.round) {
      r.round = round;
      r.phase = "reviewing";
      r.statuses = {};
      r.plan = null;
      r.questions = readJson(questionsFile(r, round), []);
      r.events = r.events.filter((e) => !e.deliveredAt && e.type === "question");
    }
    r.lastAgentActivity = now();
    saveRegistry();
    save(r);
    return send(res, 200, { id: r.id, round, republished, url: `http://127.0.0.1:${port}/r/${r.id}`, tabs: openTabs(r), dir });
  }

  // ---------- per review
  if (parts[1] !== "r" || !parts[2]) return send(res, 404, { error: "not found" });
  const r = reviews.get(parts[2]);
  if (!r) return send(res, 404, { error: "unknown review" });
  const action = parts[3];

  if (admin) {
    if (noteAgent(r, req)) broadcast(r);
    if (req.method === "GET" && action === "next-event") {
      if (deliver(r, res)) return;
      const wasListening = listening(r);
      const list = waiters.get(r.id) ?? [];
      waiters.set(r.id, list);
      const w = {
        res,
        timer: setTimeout(() => {
          list.splice(list.indexOf(w), 1);
          waiterGone(r);
          send(res, 204, {});
        }, LONG_POLL_MS),
      };
      list.push(w);
      if (!wasListening) broadcast(r);
      req.on("close", () => {
        const i = list.indexOf(w);
        if (i >= 0) {
          clearTimeout(w.timer);
          list.splice(i, 1);
          waiterGone(r);
        }
      });
      return;
    }
    // A new session picks up a review: the event a lost session never handled, or none.
    if (req.method === "GET" && action === "resume") {
      const e = openEvent(r);
      const comments = submittedComments(r);
      const skipped = new Set((r.plan?.steps ?? []).flatMap((s, i) => ((r.plan.decision?.kinds?.[i] ?? s.kind) === "skip" ? s.comments : [])));
      const open = comments.filter((c) => !skipped.has(c.id) && (!r.statuses[c.id] || r.statuses[c.id].status === "working"));
      const review = { id: r.id, round: r.round, dir: r.dir, phase: r.phase, file: reviewFile(r, r.round), comments: comments.length, open };
      if (!e) return send(res, 200, { event: null, review });
      e.deliveredAt = now();
      r.lastAgentActivity = now();
      save(r);
      const payload = { ...e };
      if (e.type === "question") payload.question = r.questions.find((q) => q.id === e.questionId);
      return send(res, 200, { event: payload, review });
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const body = JSON.parse(await readBody(req));
    r.lastAgentActivity = now();

    if (action === "answers") {
      const q = r.questions.find((x) => x.id === body.questionId);
      if (!q || !String(body.text ?? "").trim()) return send(res, 400, { error: "unknown question or empty answer" });
      q.answer = { text: String(body.text).trim(), ref: body.ref ?? undefined, answeredAt: now() };
      for (const e of r.events) if (e.type === "question" && e.questionId === q.id) e.handledAt ??= now();
      save(r);
      return send(res, 200, { ok: true });
    }
    if (action === "plan") {
      if (!Array.isArray(body.steps) || !body.steps.length) return send(res, 400, { error: "a plan needs steps" });
      r.plan = { round: r.round, steps: body.steps, note: body.note ?? null, createdAt: now(), decision: null };
      r.phase = "planning";
      markHandled(r, "review-submitted", "plan-decision");
      save(r);
      return send(res, 200, { ok: true });
    }
    if (action === "status") {
      if (typeof body.commentId !== "string" || typeof body.status !== "string") return send(res, 400, { error: "commentId and status are required" });
      r.statuses[body.commentId] = { status: body.status, text: body.text ?? null, ref: body.ref ?? undefined, at: now() };
      markHandled(r, "review-submitted", "plan-decision");
      if (r.phase === "sent" || r.phase === "planning") r.phase = "working";
      const finished = finishIfSettled(r);
      save(r);
      return send(res, 200, { ok: true, finished, round: r.round });
    }
    // The agent opened a pull request: show it now, and follow it from here.
    if (action === "pr") {
      const m = String(body.url ?? "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) return send(res, 400, { error: "url must be a pull request on github.com, like https://github.com/owner/repo/pull/12" });
      const [url, owner, name, number] = m;
      const auth = await githubToken();
      let pr;
      try {
        if (auth.token) {
          const answer = await githubGet(`/repos/${owner}/${name}/pulls/${number}`, auth.token);
          if (!answer.ok) throw githubError(answer);
          pr = prFrom(await answer.json());
        } else if (auth.gh) pr = await ghPr(undefined, url);
      } catch (e) {
        return send(res, 502, { error: `Could not read the pull request: ${e.message}` });
      }
      // Without gh, what the URL says: a pull request just opened is open.
      pr ??= { number: Number(number), url, title: typeof body.title === "string" ? body.title : null, state: "OPEN", base: null, mergedAt: null, checkedAt: now() };
      setPr(r, pr);
      // The next poll must answer in full, not with "nothing changed" since the look before this one.
      r.prEtag = null;
      r.prNextAt = 0;
      return send(res, 200, { pr: r.pr });
    }
    return send(res, 404, { error: "not found" });
  }

  // ---------- page API, page token
  if (!same(req.headers["x-review-token"], pageToken)) return send(res, 401, { error: "bad token" });

  if (req.method === "GET") {
    if (action === "draft") return send(res, 200, { round: r.round, comments: readJson(draftFile(r), { comments: [] }).comments ?? [] });
    if (action === "bundle") {
      const entry = r.rounds.find((x) => x.round === Number(url.searchParams.get("round"))) ?? r.rounds.at(-1);
      const raw = entry ? roundText(roundFile(entry)) : null;
      // Already JSON text, so send it as is.
      return raw ? send(res, 200, raw, "application/json; charset=utf-8") : send(res, 404, { error: "no such round" });
    }
    return send(res, 404, { error: "not found" });
  }

  if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "send JSON" });
  const body = JSON.parse(await readBody(req));

  if (req.method === "POST" && action === "presence") {
    if (typeof body.tab !== "string") return send(res, 400, { error: "tab is required" });
    if (!presence.has(r.id)) presence.set(r.id, new Map());
    presence.get(r.id).set(body.tab, Date.now());
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "questions") {
    if (typeof body.id !== "string" || !String(body.text ?? "").trim() || !validTarget(body.target)) return send(res, 400, { error: "question is not valid" });
    if (!r.questions.some((q) => q.id === body.id)) {
      r.questions.push({ id: body.id, target: body.target, text: String(body.text).trim(), askedAt: now(), answer: null });
      pushEvent(r, "question", { questionId: body.id });
      save(r);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "archive") {
    r.archived = body.archived === false ? null : now();
    saveRegistry();
    save(r);
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && action === "delete") {
    if (!r.archived) return send(res, 409, { error: "archive the review first" });
    await deleteReview(r);
    return send(res, 200, { ok: true });
  }

  // The reviewer asks the agent to rebuild this round because the code changed after it was built.
  if (req.method === "POST" && action === "refresh") {
    if (r.phase !== "reviewing") return send(res, 409, { error: "the round was already sent" });
    if (!r.events.some((e) => e.type === "refresh" && !e.handledAt)) {
      pushEvent(r, "refresh", { round: r.round, files: r.drift?.files ?? [], commits: r.drift?.commits ?? 0 });
      save(r);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "plan-decision") {
    if (!r.plan || r.phase !== "planning") return send(res, 409, { error: "no plan is waiting for a decision" });
    const decision = body.decision === "changes" ? "changes" : "approve";
    r.plan.decision = { decision, note: body.note ?? null, kinds: body.kinds ?? {}, at: now() };
    r.phase = decision === "approve" ? "working" : "sent";
    pushEvent(r, "plan-decision", { decision: r.plan.decision });
    save(r);
    return send(res, 200, { ok: true });
  }

  if (!validComments(body.comments)) return send(res, 400, { error: "comments are not valid" });

  if (req.method === "PUT" && action === "draft") {
    if (r.phase !== "reviewing") return send(res, 409, { error: "this round was already sent" });
    writeJson(draftFile(r), { round: r.round, comments: body.comments });
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "submit") {
    if (r.phase !== "reviewing") return send(res, 409, { error: "this round was already sent" });
    const bundleHead = r.rounds.find((x) => x.round === r.round);
    const review = {
      version: 1,
      round: r.round,
      branch: r.branch,
      headSha: String(body.headSha ?? ""),
      snapshot: String(body.snapshot ?? ""),
      submittedAt: now(),
      comments: body.comments,
      questions: r.questions.map(({ deliveredAt: _, ...q }) => q),
      report: bundleHead ? roundFile(bundleHead) : null,
    };
    writeJson(reviewFile(r, r.round), review);
    rmSync(draftFile(r), { force: true });
    r.phase = body.comments.length ? "sent" : "done";
    // An update asked for this round is moot once the round is sent.
    markHandled(r, "refresh");
    pushEvent(r, "review-submitted", { round: r.round, file: reviewFile(r, r.round), count: body.comments.length });
    save(r);
    return send(res, 200, { ok: true, round: r.round });
  }

  return send(res, 404, { error: "not found" });
}

// ------------------------------------------------------------------ start

// True when something already accepts connections on the port, over IPv4 or IPv6.
// Binding 127.0.0.1 can succeed even when another program listens on all addresses
// (Docker and OrbStack do), and the browser may then reach that program over IPv6.
const answers = (host, port) =>
  new Promise((resolveAnswer) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolveAnswer(result);
    };
    socket.setTimeout(300, () => done(false));
    // Close politely, so the other program sees a normal disconnect.
    socket.once("connect", () => {
      socket.end();
      resolveAnswer(true);
    });
    socket.once("error", () => done(false));
  });
const portTaken = async (port) => (await answers("127.0.0.1", port)) || (await answers("::1", port));

async function listen(port, attempt = 0) {
  if (attempt > 20) {
    console.error(`No free port between ${FIRST_PORT} and ${port}.`);
    process.exit(1);
  }
  if (await portTaken(port)) {
    console.log(`Port ${port} is in use by another program, trying ${port + 1}.`);
    return listen(port + 1, attempt + 1);
  }
  const server = createServer((req, res) =>
    handle(req, res, port).catch((e) => {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }),
  );
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") void listen(port + 1, attempt + 1);
    else {
      console.error(e.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    writeJson(daemonFile, { port, pid: process.pid, version: VERSION, adminToken, startedAt: now() }, 0o600);
    console.log(`pr-report daemon ${VERSION} on http://127.0.0.1:${port}/ (pid ${process.pid})`);
  });
}

const cleanup = () => {
  if (lockOwner()?.pid === process.pid) rmSync(lockFile, { force: true });
  const info = readJson(daemonFile, {});
  if (info.pid === process.pid) rmSync(daemonFile, { force: true });
};
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_MS) {
    console.log("No activity for a while, stopping.");
    process.exit(0);
  }
}, 60_000).unref();

// Project checks write checks.json as they go. Stream every change to open pages, and notice a run
// whose process ended without finishing.
setInterval(() => {
  for (const r of reviews.values()) {
    let mtime = 0;
    try {
      mtime = statSync(r.checksFile).mtimeMs;
    } catch {
      // No checks for this review (yet).
    }
    if (mtime === r.checksMtime && r.checks?.status !== "running") continue;
    r.checksMtime = mtime;
    const next = readChecksRun(r.checksFile);
    if (JSON.stringify(next) === JSON.stringify(r.checks ?? null)) continue;
    r.checks = next;
    broadcast(r);
  }
}, 1000).unref();

// Reviews that finished their last comment before the daemon knew to end the round.
for (const r of reviews.values()) if (finishIfSettled(r)) save(r);

void listen(FIRST_PORT);
console.log(`Reviews known: ${reviews.size}. Home: ${HOME}`);
