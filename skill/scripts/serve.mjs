#!/usr/bin/env node
// Serves a report on 127.0.0.1 so its page can save review comments and send them to Claude.
// "Send to Claude" writes review-<round>.json next to the report and ends this process. An agent
// waiting on the process (for example a background shell in Claude Code) then reads that file.
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
const MAX_BODY = 5 * 1024 * 1024;

const rounds = readdirSync(dir)
  .map((f) => f.match(/^review-(\d+)\.json$/)?.[1])
  .filter(Boolean)
  .map(Number);
const round = rounds.length ? Math.max(...rounds) + 1 : 1;

// The token only exists in the page this server sends, so other local pages cannot post comments,
// which would otherwise reach the agent as instructions.
const token = randomBytes(24).toString("hex");
const html = readFileSync(args.report, "utf8").replace(
  "</head>",
  () => `<script>window.__PR_REVIEW__=${JSON.stringify({ token, round })}</script></head>`,
);

const readDraft = () => {
  try {
    return JSON.parse(readFileSync(draftFile, "utf8"));
  } catch {
    return { comments: [] };
  }
};

const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
};

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

const validComments = (value) =>
  Array.isArray(value) &&
  value.every((c) => c && typeof c.id === "string" && typeof c.text === "string" && c.target && typeof c.target.type === "string");

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

const server = createServer(async (req, res) => {
  resetIdle();
  const { port } = server.address();
  const host = String(req.headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "wrong host" });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return send(res, 403, { error: "wrong origin" });

  const url = new URL(req.url ?? "/", `http://${host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, html, "text/html; charset=utf-8");

    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (!tokenOk(req)) return send(res, 401, { error: "bad token" });

    if (req.method === "GET" && url.pathname === "/api/review") return send(res, 200, { round, comments: readDraft().comments ?? [] });

    if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "send JSON" });
    const body = JSON.parse(await readBody(req));
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
      };
      writeJson(file, review);
      rmSync(draftFile, { force: true });
      send(res, 200, { ok: true, round, file });
      console.log(`Review submitted: ${file}`);
      console.log(summarize(review.comments));
      setTimeout(() => process.exit(0), 300);
      return;
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(args.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Review server for round ${round}: ${url}`);
  console.log(`It stops when the reviewer clicks "Send to Claude", or after ${args.timeout} minutes without activity.`);
  resetIdle();
  if (args.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  }
});
