#!/usr/bin/env node
// Serves a report on 127.0.0.1 so its page can save review comments, ask live questions, and send
// the review to Claude. "Send to Claude" writes review-<round>.json next to the report and ends this
// process; an agent waiting on the process (a background shell in Claude Code) then reads that file.
// Live questions reach the agent through questions.mjs, which talks to the endpoints below.
//
// Usage: node serve.mjs --report <report.html> [--open] [--timeout <minutes>] [--port <port>]

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { open: false, timeout: 240, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--report") args.report = resolve(next());
    else if (a === "--open") args.open = true;
    else if (a === "--timeout") args.timeout = Number(next());
    else if (a === "--port") args.port = Number(next());
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.report || !existsSync(args.report)) throw new Error("--report <file.html> is required and must exist");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dir = dirname(args.report);
const draftFile = join(dir, "review-draft.json");
const sessionFile = join(dir, "review-session.json");
const MAX_BODY = 5 * 1024 * 1024;
const LONG_POLL_MS = 25_000;
// A question handed to the agent but not answered within this time is handed out again.
const REDELIVER_MS = 120_000;

const rounds = readdirSync(dir)
  .map((f) => f.match(/^review-(\d+)\.json$/)?.[1])
  .filter(Boolean)
  .map(Number);
const round = rounds.length ? Math.max(...rounds) + 1 : 1;
const questionsFile = join(dir, `questions-${round}.json`);

// The token only exists in the page this server sends and in review-session.json, so other local
// pages cannot post comments or questions, which would otherwise reach the agent as instructions.
const token = randomBytes(24).toString("hex");
const html = readFileSync(args.report, "utf8").replace(
  "</head>",
  () => `<script>window.__PR_REVIEW__=${JSON.stringify({ token, round })}</script></head>`,
);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
};

const questions = readJson(questionsFile, []);
const saveQuestions = () => writeJson(questionsFile, questions);

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
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

const tokenOk = (req) => {
  const given = Buffer.from(String(req.headers["x-review-token"] ?? ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const validTarget = (t) => t && typeof t.type === "string";
const validComments = (value) =>
  Array.isArray(value) && value.every((c) => c && typeof c.id === "string" && typeof c.text === "string" && validTarget(c.target));

// ------------------------------------------------------------------ live questions

const waiters = [];
const nextQuestion = () =>
  questions.find((q) => !q.answer && (!q.deliveredAt || Date.now() - Date.parse(q.deliveredAt) > REDELIVER_MS));

const deliver = (res) => {
  const q = nextQuestion();
  if (!q) return false;
  q.deliveredAt = new Date().toISOString();
  saveQuestions();
  send(res, 200, { question: q, round });
  return true;
};

const wakeWaiters = () => {
  while (waiters.length) {
    const waiter = waiters[0];
    if (!deliver(waiter.res)) break;
    clearTimeout(waiter.timer);
    waiters.shift();
  }
};

// ------------------------------------------------------------------ idle stop

let idleTimer;
const resetIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const kept = existsSync(draftFile) ? ` Unsent comments are kept in ${draftFile}.` : "";
    console.log(`No review was sent within ${args.timeout} minutes, so the review server stopped.${kept}`);
    process.exit(0);
  }, args.timeout * 60_000);
};

const summarize = (comments) => {
  if (!comments.length) return "No comments: the reviewer is happy with this round.";
  const counts = {};
  for (const c of comments) counts[c.kind ?? "unmarked"] = (counts[c.kind ?? "unmarked"] ?? 0) + 1;
  const parts = Object.entries(counts).map(([k, n]) => (k === "unmarked" ? `${n} without a kind (infer it)` : `${n} ${k}`));
  return `${comments.length} comments: ${parts.join(", ")}`;
};

// ------------------------------------------------------------------ routes

const server = createServer(async (req, res) => {
  const { port } = server.address();
  const host = String(req.headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "wrong host" });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return send(res, 403, { error: "wrong origin" });

  const url = new URL(req.url ?? "/", `http://${host}`);
  // The agent's long poll is not reviewer activity, so it does not keep the server alive.
  if (url.pathname !== "/api/next-question") resetIdle();

  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, html, "text/html; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (!tokenOk(req)) return send(res, 401, { error: "bad token" });

    if (req.method === "GET") {
      if (url.pathname === "/api/review") return send(res, 200, { round, comments: readJson(draftFile, { comments: [] }).comments ?? [] });
      if (url.pathname === "/api/questions") return send(res, 200, { questions });
      if (url.pathname === "/api/next-question") {
        if (deliver(res)) return;
        const waiter = { res, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          send(res, 204, {});
        }, LONG_POLL_MS) };
        waiters.push(waiter);
        req.on("close", () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            clearTimeout(waiter.timer);
            waiters.splice(i, 1);
          }
        });
        return;
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "send JSON" });
    const body = JSON.parse(await readBody(req));

    if (req.method === "POST" && url.pathname === "/api/questions") {
      if (typeof body.id !== "string" || typeof body.text !== "string" || !body.text.trim() || !validTarget(body.target)) {
        return send(res, 400, { error: "question is not valid" });
      }
      if (!questions.some((q) => q.id === body.id)) {
        questions.push({ id: body.id, target: body.target, text: body.text.trim(), askedAt: new Date().toISOString(), deliveredAt: null, answer: null });
        saveQuestions();
        wakeWaiters();
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/answers") {
      const q = questions.find((x) => x.id === body.id);
      if (!q || typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: "unknown question or empty answer" });
      q.answer = { text: body.text.trim(), ref: body.ref ?? undefined, answeredAt: new Date().toISOString() };
      saveQuestions();
      return send(res, 200, { ok: true });
    }

    if (!validComments(body.comments)) return send(res, 400, { error: "comments are not valid" });

    if (req.method === "PUT" && url.pathname === "/api/review") {
      writeJson(draftFile, { round, comments: body.comments });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/submit") {
      const file = join(dir, `review-${round}.json`);
      const review = {
        version: 1,
        round,
        branch: String(body.branch ?? ""),
        headSha: String(body.headSha ?? ""),
        snapshot: String(body.snapshot ?? ""),
        submittedAt: new Date().toISOString(),
        comments: body.comments,
        questions: questions.map(({ deliveredAt: _, ...q }) => q),
      };
      writeJson(file, review);
      rmSync(draftFile, { force: true });
      send(res, 200, { ok: true, round, file });
      console.log(`Review submitted: ${file}`);
      console.log(summarize(review.comments));
      const open = questions.filter((q) => !q.answer).length;
      if (open) console.log(`${open} live questions were not answered; answer them in the fix loop.`);
      setTimeout(() => process.exit(0), 300);
      return;
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

process.on("exit", () => rmSync(sessionFile, { force: true }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

server.listen(args.port, "127.0.0.1", () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  writeJson(sessionFile, { port, token, round, pid: process.pid });
  console.log(`Review server for round ${round}: ${url}`);
  console.log(`It stops when the reviewer clicks "Send to Claude", or after ${args.timeout} minutes without activity.`);
  console.log(`Live questions: run questions.mjs wait --dir "${dir}" in the background.`);
  resetIdle();
  if (args.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  }
});
