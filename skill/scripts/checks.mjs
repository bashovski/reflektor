#!/usr/bin/env node
// Runs the project's own checks (lint, typecheck, tests...) and writes checks.json for the report.
// Commands come from --run, or from "checks" in .pr-report.json. A failing check is a fact for the
// report, not an error, so this script exits 0 unless it cannot run at all.
//
// The skill starts it in the background and reads the diff meanwhile. checks.json says "running"
// until the last check ends, and --wait blocks until then and prints the results.
//
// Usage: node checks.mjs --repo . [--run "name=command"]... [--timeout <seconds>] [--out checks.json]
//        node checks.mjs --repo . --wait [--out checks.json]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_OUTPUT = 400 * 1024;
const TAIL_LINES = 80;

function parseArgs(argv) {
  const args = { repo: ".", runs: [], timeout: 600, out: null, wait: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--repo") args.repo = next();
    else if (a === "--run") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error(`--run needs "name=command", got: ${spec}`);
      args.runs.push({ name: spec.slice(0, eq).trim(), command: spec.slice(eq + 1).trim() });
    } else if (a === "--timeout") args.timeout = Number(next());
    else if (a === "--out") args.out = next();
    else if (a === "--wait") args.wait = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const git = (...argv) => execFileSync("git", argv, { cwd: resolve(args.repo), encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const gitDir = resolve(root, git("rev-parse", "--git-dir"));
const out = resolve(args.out ?? join(gitDir, "pr-report", "checks.json"));

const readRun = () => {
  try {
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const running = (run) => run?.status === "running" && alive(run.pid);

function printResults(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nProject checks: ${count("passed")} passed, ${count("failed")} failed, ${count("timeout")} timed out`);
  console.log(`Wrote ${out}`);
  for (const r of results.filter((r) => r.status !== "passed")) {
    console.log(`\n--- ${r.name} (${r.status}), last lines:`);
    console.log(r.outputTail.split("\n").slice(-15).join("\n"));
  }
}

// Under the 10-minute limit agents put on one command; past it, the agent runs --wait again.
const WAIT_LIMIT_MS = 9 * 60_000;

if (args.wait) {
  let run = readRun();
  const started = Date.now();
  if (running(run)) console.log(`Waiting for: ${run.checks.filter((name) => !run.results.some((r) => r.name === name)).join(", ")}`);
  while (running(run)) {
    if (Date.now() - started > WAIT_LIMIT_MS) {
      console.log("The checks are still running after 9 minutes. Run --wait again.");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1000));
    run = readRun();
  }
  if (!run) {
    console.log("No project checks have run for this repo.");
    process.exit(0);
  }
  if (run.status === "running") console.log("The checks stopped before they finished. Results of the ones that did:");
  printResults(run.results);
  process.exit(0);
}

if (running(readRun())) {
  console.log(`Checks are already running for this repo (pid ${readRun().pid}). Wait for them with --wait.`);
  process.exit(0);
}

let checks = args.runs;
if (!checks.length) {
  const configFile = join(root, ".pr-report.json");
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  checks = (config.checks ?? []).map((c) => ({ name: c.name, command: c.command, timeout: c.timeout }));
}
if (!checks.length) {
  console.log('No checks to run. Pass --run "name=command" or add "checks" to .pr-report.json.');
  process.exit(0);
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function runCheck({ name, command, timeout }) {
  const limit = (timeout ?? args.timeout) * 1000;
  const started = Date.now();
  return new Promise((done) => {
    const shell = process.platform === "win32" ? ["cmd", ["/c", command]] : ["sh", ["-c", command]];
    const child = spawn(shell[0], shell[1], { cwd: root, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, detached: process.platform !== "win32" });
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, limit);
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stripAnsi(output).trimEnd().split("\n");
      done({
        name,
        command,
        status: timedOut ? "timeout" : code === 0 ? "passed" : "failed",
        exitCode: timedOut ? null : code,
        durationMs: Date.now() - started,
        outputTail: lines.slice(-TAIL_LINES).join("\n"),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ name, command, status: "failed", exitCode: null, durationMs: Date.now() - started, outputTail: e.message });
    });
  });
}

// Written after every check, so --wait and build.mjs see the run's progress.
const headSha = git("rev-parse", "HEAD");
const startedAt = new Date().toISOString();
const results = [];
const save = (status) => {
  const run =
    status === "running"
      ? { version: 1, status, pid: process.pid, startedAt, headSha, checks: checks.map((c) => c.name), results }
      : { version: 1, status, ranAt: new Date().toISOString(), headSha, results };
  writeFileSync(`${out}.tmp`, JSON.stringify(run, null, 2));
  renameSync(`${out}.tmp`, out);
};
mkdirSync(dirname(out), { recursive: true });
save("running");

for (const check of checks) {
  process.stdout.write(`Running ${check.name}: ${check.command} ... `);
  const result = await runCheck(check);
  results.push(result);
  save("running");
  console.log(`${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`);
}

save("done");
printResults(results);
