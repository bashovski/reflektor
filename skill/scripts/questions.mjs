#!/usr/bin/env node
// The agent's side of live questions. While serve.mjs runs:
//   wait    blocks until the reviewer asks a question, prints it, and exits (run it in the background)
//   answer  sends an answer back; the page shows it within a few seconds
//
// Usage: node questions.mjs wait --dir <report folder>
//        node questions.mjs answer --dir <report folder> --id <question id> (--text "..." | --text-file <file>) [--ref path:line]

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];
if (!["wait", "answer"].includes(command) || !args.dir) {
  console.log("Usage: questions.mjs wait --dir <report folder> | answer --dir <report folder> --id <id> --text <answer>");
  process.exit(2);
}

const sessionFile = join(resolve(args.dir), "review-session.json");
if (!existsSync(sessionFile)) {
  console.log("The review server is not running, so there are no live questions.");
  process.exit(0);
}
const session = JSON.parse(readFileSync(sessionFile, "utf8"));
const base = `http://127.0.0.1:${session.port}`;
const headers = { "x-review-token": session.token };

const describe = (t) => {
  switch (t.type) {
    case "line":
      return `${t.path} ${t.start === t.end ? `line ${t.start}` : `lines ${t.start}-${t.end}`} (${t.side} version)`;
    case "file":
      return t.path;
    case "report":
      return "the whole change";
    default:
      return `${t.type}: ${t.text ?? ""}`;
  }
};

if (command === "wait") {
  for (;;) {
    let res;
    try {
      res = await fetch(`${base}/api/next-question`, { headers, signal: AbortSignal.timeout(60_000) });
    } catch {
      console.log("The review server stopped. If the reviewer sent the review, its output says so.");
      process.exit(0);
    }
    if (res.status === 204) continue;
    if (!res.ok) {
      console.log(`The review server refused the request (${res.status}).`);
      process.exit(1);
    }
    const { question: q } = await res.json();
    console.log(`Live question ${q.id} from the reviewer`);
    console.log(`About: ${describe(q.target)}`);
    if (q.target.type === "line") console.log(["```", q.target.code, "```"].join("\n"));
    if (q.target.fix) console.log(`Suggested fix shown with it: ${q.target.fix}`);
    console.log(`Question: ${q.text}`);
    console.log("");
    console.log(`Answer it: node questions.mjs answer --dir "${args.dir}" --id ${q.id} --text "<answer>"`);
    console.log("Then run wait again to catch the next question.");
    process.exit(0);
  }
}

if (command === "answer") {
  const text = args["text-file"] ? readFileSync(args["text-file"], "utf8") : args.text;
  if (!args.id || !text) {
    console.log("answer needs --id and --text (or --text-file).");
    process.exit(2);
  }
  let ref;
  if (args.ref) {
    const [path, line] = args.ref.split(":");
    ref = { path, line: line ? Number(line) : undefined };
  }
  const res = await fetch(`${base}/api/answers`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ id: args.id, text, ref }),
  });
  console.log(res.ok ? `Answered ${args.id}. The page shows it within a few seconds.` : `Could not answer: ${(await res.json()).error}`);
  process.exit(res.ok ? 0 : 1);
}
