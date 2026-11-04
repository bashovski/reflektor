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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
const writeJson = (file, value, mode) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  renameSync(`${file}.tmp`, file);
};
const now = () => new Date().toISOString();
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ single instance

function takeLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockFile, "wx"));
      writeFileSync(lockFile, String(process.pid));
      return true;
    } catch {
      const owner = Number(readFileSync(lockFile, "utf8"));
      if (owner && pidAlive(owner)) return false;
      rmSync(lockFile, { force: true });
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
    repo: entry.repo,
    branch: entry.branch,
    rounds: saved.rounds ?? [],
    phase: saved.phase ?? "reviewing",
    statuses: saved.statuses ?? {},
    plan: saved.plan ?? null,
    events: saved.events ?? [],
    lastAgentActivity: saved.lastAgentActivity ?? null,
    updatedAt: saved.updatedAt ?? now(),
  };
  r.round = r.rounds.at(-1)?.round ?? 1;
  r.questions = readJson(questionsFile(r, r.round), []);
  return r;
}
for (const entry of registry) {
  const r = loadReview(entry);
  if (r) reviews.set(r.id, r);
}

const saveRegistry = () =>
  writeJson(
    registryFile,
    [...reviews.values()].map(({ id, dir, title, tag, repo, branch }) => ({ id, dir, title, tag, repo, branch })),
  );

function save(r) {
  r.updatedAt = now();
  writeJson(stateFile(r), {
    rounds: r.rounds,
    phase: r.phase,
    statuses: r.statuses,
    plan: r.plan,
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
  lastAgentActivity: r.lastAgentActivity,
  updatedAt: r.updatedAt,
});

// ------------------------------------------------------------------ live stream to pages (SSE)

const streams = new Set();
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

function nextEvent(r) {
  const ready = (e) => !e.deliveredAt || (e.type === "question" && Date.now() - Date.parse(e.deliveredAt) > REDELIVER_MS);
  for (const e of r.events) {
    if (e.type === "question" && r.questions.find((q) => q.id === e.questionId)?.answer) continue;
    if (ready(e)) return e;
  }
  return null;
}

function deliver(r, res) {
  const e = nextEvent(r);
  if (!e) return false;
  e.deliveredAt = now();
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
  r.events.push({ seq: (r.events.at(-1)?.seq ?? 0) + 1, type, at: now(), deliveredAt: null, ...data });
  r.events = r.events.slice(-200);
}

// ------------------------------------------------------------------ HTTP helpers

const send = (res, status, body, type = "application/json") => {
  // Pages must not be framed by other sites (clickjacking on Send or Fix this).
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
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

const PHASES = {
  reviewing: ["Waiting on you", "#b45309"],
  sent: ["Sent to Claude", "#2563eb"],
  planning: ["Plan ready", "#7c3aed"],
  working: ["Claude working", "#2563eb"],
  done: ["Done", "#059669"],
};

function inboxPage() {
  const rows = [...reviews.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => {
      const [label, color] = PHASES[r.phase] ?? [r.phase, "#71717a"];
      const waiting = r.questions.filter((q) => !q.answer).length;
      return `<a class="row" href="/r/${encodeURIComponent(r.id)}">
        <span class="tag">${escapeHtml(r.tag ?? "")}</span>
        <span class="main"><span class="title">${escapeHtml(r.title ?? r.branch)}</span>
        <span class="meta">${escapeHtml(r.repo)} · ${escapeHtml(r.branch)} · round ${r.round}${waiting ? ` · ${waiting} question${waiting === 1 ? "" : "s"} waiting` : ""}</span></span>
        <span class="phase" style="color:${color}">${label}</span>
        <time data-at="${r.updatedAt}"></time></a>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PR reports</title><style>
:root{--bg:#fafafa;--surface:#fff;--border:#e4e4e7;--text:#18181b;--muted:#71717a;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--surface:#111113;--border:#27272a;--text:#f4f4f5;--muted:#a1a1aa}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:40px 16px}h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 24px}
.list{border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow:hidden}
.row{display:flex;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--border);color:inherit;text-decoration:none}
.row:first-child{border-top:0}.row:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}
.tag{font:600 11px ui-monospace,monospace;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,var(--text) 8%,transparent);min-width:64px;text-align:center}
.main{flex:1;min-width:0;display:flex;flex-direction:column}.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta,time{color:var(--muted);font-size:12px}.phase{font-size:12px;font-weight:600;white-space:nowrap}time{min-width:64px;text-align:right}
.empty{padding:32px;text-align:center;color:var(--muted)}</style></head><body><main>
<h1>PR reports</h1><p>Every review on this machine. Open one to comment, ask questions and send it to Claude.</p>
<div class="list">${rows || '<div class="empty">No reviews yet. Run /pr-report in a repo.</div>'}</div></main>
<script>
const ago=(t)=>{const s=(Date.now()-Date.parse(t))/1000;return s<60?"now":s<3600?Math.round(s/60)+" min ago":s<86400?Math.round(s/3600)+" h ago":Math.round(s/86400)+" d ago"};
for(const el of document.querySelectorAll("time"))el.textContent=ago(el.dataset.at);
// The stream starts with every review's current state, so reload only for a review that changed or is new.
const shown=${JSON.stringify(Object.fromEntries([...reviews.values()].map((r) => [r.id, r.updatedAt]))).replace(/</g, "\\u003c")};
const es=new EventSource("/api/events?token=${pageToken}&watch=*");let t;
es.addEventListener("state",(e)=>{const s=JSON.parse(e.data);if(shown[s.id]===s.updatedAt)return;clearTimeout(t);t=setTimeout(()=>location.reload(),400)});
</script></body></html>`;
}

// The viewer's app build. Every review page is the same app; it loads its round's data from the API.
const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = [join(here, "../assets/app"), join(here, "../../viewer/dist/app")].find((d) => existsSync(join(d, "index.html")));
const ASSET_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function reviewPage(r, round) {
  const entry = r.rounds.find((x) => x.round === round) ?? r.rounds.at(-1);
  if (!entry || !existsSync(roundFile(entry))) return null;
  const config = { live: true, id: r.id, round: entry.round, token: pageToken, api: `/api/r/${encodeURIComponent(r.id)}` };
  return readFileSync(join(APP_DIR, "index.html"), "utf8").replace("</head>", () => `<script>window.__PR_REVIEW__=${JSON.stringify(config)}</script></head>`);
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

  if (req.method === "GET" && url.pathname === "/") return send(res, 200, inboxPage(), "text/html; charset=utf-8");
  if ((parts[0] === "r" || parts[0] === "app") && !APP_DIR) return send(res, 500, "The viewer is not built. Run pnpm build in the pr-report checkout.", "text/plain");
  if (req.method === "GET" && parts[0] === "app" && parts[1] === "assets") return sendAsset(res, parts.slice(1));
  if (req.method === "GET" && parts[0] === "r" && parts[1]) {
    const r = reviews.get(parts[1]);
    const html = r && reviewPage(r, Number(url.searchParams.get("round")) || r.round);
    return html ? send(res, 200, html, "text/html; charset=utf-8") : send(res, 404, "Review not found", "text/plain");
  }

  if (parts[0] !== "api") return send(res, 404, { error: "not found" });

  // ---------- agent API (review.mjs), admin token
  const admin = same(req.headers["x-admin-token"], adminToken);
  if (parts[1] === "health") return admin ? send(res, 200, { ok: true, version: VERSION, pid: process.pid }) : send(res, 401, { error: "bad token" });
  if (parts[1] === "shutdown" && admin) {
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
    req.on("close", () => streams.delete(res));
    return;
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
      r = { id, dir, repo, branch, rounds: [], phase: "reviewing", statuses: {}, plan: null, events: [], lastAgentActivity: null, questions: [], round: bundle.round };
      reviews.set(id, r);
    }
    r.title = bundle.report.title;
    r.tag = bundle.report.tag;
    const round = bundle.round ?? r.round;
    r.rounds = [...r.rounds.filter((x) => x.round !== round), { round, file, publishedAt: now() }].sort((a, b) => a.round - b.round);
    if (round !== r.round || r.phase !== "reviewing") {
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
    return send(res, 200, { id: r.id, round: r.round, url: `http://127.0.0.1:${port}/r/${r.id}`, tabs: openTabs(r), dir });
  }

  // ---------- per review
  if (parts[1] !== "r" || !parts[2]) return send(res, 404, { error: "not found" });
  const r = reviews.get(parts[2]);
  if (!r) return send(res, 404, { error: "unknown review" });
  const action = parts[3];

  if (admin) {
    if (req.method === "GET" && action === "next-event") {
      if (deliver(r, res)) return;
      const list = waiters.get(r.id) ?? [];
      waiters.set(r.id, list);
      const w = {
        res,
        timer: setTimeout(() => {
          list.splice(list.indexOf(w), 1);
          send(res, 204, {});
        }, LONG_POLL_MS),
      };
      list.push(w);
      req.on("close", () => {
        const i = list.indexOf(w);
        if (i >= 0) {
          clearTimeout(w.timer);
          list.splice(i, 1);
        }
      });
      return;
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const body = JSON.parse(await readBody(req));
    r.lastAgentActivity = now();

    if (action === "answers") {
      const q = r.questions.find((x) => x.id === body.questionId);
      if (!q || !String(body.text ?? "").trim()) return send(res, 400, { error: "unknown question or empty answer" });
      q.answer = { text: String(body.text).trim(), ref: body.ref ?? undefined, answeredAt: now() };
      save(r);
      return send(res, 200, { ok: true });
    }
    if (action === "plan") {
      if (!Array.isArray(body.steps) || !body.steps.length) return send(res, 400, { error: "a plan needs steps" });
      r.plan = { round: r.round, steps: body.steps, note: body.note ?? null, createdAt: now(), decision: null };
      r.phase = "planning";
      save(r);
      return send(res, 200, { ok: true });
    }
    if (action === "status") {
      if (typeof body.commentId !== "string" || typeof body.status !== "string") return send(res, 400, { error: "commentId and status are required" });
      r.statuses[body.commentId] = { status: body.status, text: body.text ?? null, ref: body.ref ?? undefined, at: now() };
      if (r.phase === "sent" || r.phase === "planning") r.phase = "working";
      save(r);
      return send(res, 200, { ok: true });
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
  rmSync(lockFile, { force: true });
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

void listen(FIRST_PORT);
console.log(`Reviews known: ${reviews.size}. Home: ${HOME}`);
