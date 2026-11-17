#!/usr/bin/env node
// Runs the project's own checks (lint, typecheck, tests...) and writes checks.json for the report.
// A failing check is a fact for the report, not an error, so this script exits 0 unless it cannot
// run at all.
//
// The commands come from, in order: --run; "checks" in .reflektor.json (shared with the team); the
// checks saved for this repo in ~/.reflektor/repos/ (yours only). With none, the agent works them out
// once from the repo and saves them with --save, so later reports skip that step.
//
// The skill starts a run in the background and reads the diff meanwhile. checks.json says "running"
// until the last check ends, and --wait blocks until then and prints the results.
//
// Usage: node checks.mjs --repo . [--run "name=command"]... [--base <ref>] [--timeout <seconds>] [--out checks.json]
//        node checks.mjs --repo . --plan          which checks would run, and from where
//        node checks.mjs --repo . --save --run "name=command"... [--when "name=glob,glob"]... --source "<where from>" --from <file>...
//        node checks.mjs --repo . --share         copy the saved checks into .reflektor.json
//        node checks.mjs --repo . --forget        delete the saved checks and trusted authors
//        node checks.mjs --repo . --wait [--out checks.json]
//
// The checks run the branch's own code. When the branch has commits by someone else, --plan says to
// ask the user first and a run refuses to start; --trust records the user's yes for those authors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { globToRegExp, needWritable, replaceFile, repoHome, reportDir, runShell, shellPath, untrustedAuthors } from "./repo.mjs";
const TAIL_LINES = 80;
function parseArgs(argv) {
    const args = { repo: ".", runs: [], when: {}, from: [], source: null, base: null, timeout: 600, out: null, mode: "run", trust: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--repo")
            args.repo = next();
        else if (a === "--run") {
            const spec = next();
            const eq = spec.indexOf("=");
            if (eq < 1)
                throw new Error(`--run needs "name=command", got: ${spec}`);
            args.runs.push({ name: spec.slice(0, eq).trim(), command: spec.slice(eq + 1).trim() });
        }
        else if (a === "--when") {
            const spec = next();
            const eq = spec.indexOf("=");
            if (eq < 1)
                throw new Error(`--when needs "name=glob,glob", got: ${spec}`);
            args.when[spec.slice(0, eq).trim()] = spec.slice(eq + 1).split(",").map((g) => g.trim()).filter(Boolean);
        }
        else if (a === "--from")
            args.from.push(next());
        else if (a === "--source")
            args.source = next();
        else if (a === "--base")
            args.base = next();
        else if (a === "--timeout")
            args.timeout = Number(next());
        else if (a === "--out")
            args.out = next();
        else if (a === "--trust")
            args.trust = true;
        else if (["--wait", "--plan", "--save", "--share", "--forget"].includes(a))
            args.mode = a.slice(2);
        else
            throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}
const args = parseArgs(process.argv.slice(2));
const git = (...argv) => execFileSync("git", argv, { cwd: resolve(args.repo), encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const gitDir = resolve(root, git("rev-parse", "--git-dir"));
const out = resolve(args.out ?? join(reportDir(gitDir, git("rev-parse", "--abbrev-ref", "HEAD")), "checks.json"));
const readRun = () => {
    try {
        return JSON.parse(readFileSync(out, "utf8"));
    }
    catch {
        return null;
    }
};
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
const running = (run) => run?.status === "running" && alive(run.pid);
function printResults(results) {
    const count = (s) => results.filter((r) => r.status === s).length;
    console.log(`\nProject checks: ${count("passed")} passed, ${count("failed")} failed, ${count("timeout")} timed out`);
    console.log(`Wrote ${shellPath(out)}`);
    for (const r of results.filter((r) => r.status !== "passed")) {
        console.log(`\n--- ${r.name} (${r.status}), last lines:`);
        console.log(r.outputTail.split("\n").slice(-15).join("\n"));
    }
}
// Under the 10-minute limit agents put on one command; past it, the agent runs --wait again.
const WAIT_LIMIT_MS = 9 * 60_000;
if (args.mode === "wait") {
    let run = readRun();
    const started = Date.now();
    if (running(run))
        console.log(`Waiting for: ${run.checks.filter((name) => !run.results.some((r) => r.name === name)).join(", ")}`);
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
    if (run.status === "running")
        console.log("The checks stopped before they finished. Results of the ones that did:");
    printResults(run.results);
    process.exit(0);
}
// ------------------------------------------------------------------ where the commands come from
const quietGit = (...argv) => {
    try {
        return execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return null;
    }
};
const savedFile = join(repoHome(root), "checks.json");
const trustFile = join(repoHome(root), "trust.json");
needWritable([dirname(out), repoHome(root)]);
const configFile = join(root, ".reflektor.json");
const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
};
const writeJson = (file, value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
// Fingerprint of a file the saved commands came from; null when it is gone.
const hashOf = (file) => {
    try {
        return createHash("sha1").update(readFileSync(join(root, file))).digest("hex");
    }
    catch {
        return null;
    }
};
const withWhen = (c) => (args.when[c.name] ? { ...c, when: args.when[c.name] } : c);
function pickChecks() {
    if (args.runs.length)
        return { source: "--run", checks: args.runs.map(withWhen) };
    const config = readJson(configFile);
    if (config?.checks?.length)
        return { source: ".reflektor.json", checks: config.checks };
    const saved = readJson(savedFile);
    if (saved?.checks?.length) {
        const changed = Object.entries(saved.from ?? {}).filter(([file, hash]) => hashOf(file) !== hash).map(([file]) => file);
        return { source: `saved for this repo on ${new Date(saved.savedAt).toLocaleDateString("en-CA")}${saved.source ? `, ${saved.source}` : ""}`, checks: saved.checks, saved, changed };
    }
    return { source: null, checks: [] };
}
// Where this branch starts: the merge base with --base or the remote's default branch.
const baseRefs = [args.base, "origin/HEAD", "origin/main", "origin/master", "main", "master"].filter((r) => Boolean(r));
function baseCommit() {
    for (const ref of baseRefs) {
        const base = quietGit("merge-base", "HEAD", ref);
        if (base)
            return base;
    }
    return null;
}
// Files this branch changes, for checks limited to some paths with "when". When no base is found,
// every check runs.
function changedFiles() {
    const base = baseCommit();
    if (!base)
        return null;
    return [...(quietGit("diff", "--name-only", base) ?? "").split("\n"), ...(quietGit("ls-files", "--others", "--exclude-standard") ?? "").split("\n")].filter(Boolean);
}
function select(checks) {
    const changed = checks.some((c) => c.when?.length) ? changedFiles() : null;
    const applies = (c) => !c.when?.length || !changed || changed.some((file) => c.when.some((glob) => globToRegExp(glob).test(file)));
    return { run: checks.filter(applies), skipped: checks.filter((c) => !applies(c)) };
}
const plural = (n) => `${n} ${n === 1 ? "check" : "checks"}`;
const describe = (c) => `${c.name}: ${c.command}${c.when?.length ? `  (only when ${c.when.join(", ")} changed)` : ""}`;
if (args.mode === "save") {
    if (!args.runs.length)
        throw new Error('--save needs at least one --run "name=command"');
    const from = Object.fromEntries(args.from.map((file) => [file, hashOf(file)]));
    for (const [file, hash] of Object.entries(from))
        if (!hash)
            console.log(`warning: ${file} is not in the repo; the saved checks will count as out of date`);
    const checks = args.runs.map(withWhen);
    writeJson(savedFile, { version: 1, savedAt: new Date().toISOString(), source: args.source, from, checks });
    console.log(`Saved ${plural(checks.length)} for this repo in ${savedFile}:`);
    for (const c of checks)
        console.log(`  ${describe(c)}`);
    console.log("They run for every report of this repo from now on. --forget deletes them; --share copies them into .reflektor.json for the team.");
    process.exit(0);
}
if (args.mode === "forget") {
    console.log(existsSync(savedFile) ? `Deleted the saved checks: ${savedFile}` : "No checks are saved for this repo.");
    if (existsSync(trustFile))
        console.log(`Deleted the trusted authors: ${trustFile}`);
    rmSync(savedFile, { force: true });
    rmSync(trustFile, { force: true });
    process.exit(0);
}
if (args.mode === "share") {
    const saved = readJson(savedFile);
    if (!saved?.checks?.length) {
        console.log("No checks are saved for this repo.");
        process.exit(0);
    }
    writeJson(configFile, { ...(readJson(configFile) ?? {}), checks: saved.checks });
    console.log(`Copied ${plural(saved.checks.length)} into ${configFile}. Commit it to share them; it now comes before the saved ones.`);
    process.exit(0);
}
const picked = pickChecks();
// Without a base, every author counts as trusted here and the checks run. Hooks do not run then (hooks.mjs).
const strangers = untrustedAuthors(root, baseRefs) ?? [];
const strangerText = () => `this branch has commits by ${strangers.map((a) => a.label).join(", ")}, and the checks run their code (tests, scripts, config)`;
if (args.mode === "plan") {
    const askFirst = () => {
        if (strangers.length)
            console.log(`\nAsk the user before starting any checks: ${strangerText()}. If they agree, start them with --trust, which trusts these authors for this repo from now on.`);
    };
    if (!picked.source) {
        console.log("No checks for this repo yet. Work them out once (the CI config first, then the project's own files), then save them:");
        console.log(`  node "${shellPath(process.argv[1])}" --repo "${root}" --save --source "<where they came from>" --from <file>... --run "name=command"... [--when "name=glob,glob"]`);
        askFirst();
        process.exit(0);
    }
    const { run, skipped } = select(picked.checks);
    console.log(`Checks come from: ${picked.source}`);
    for (const c of run)
        console.log(`  ${describe(c)}`);
    for (const c of skipped)
        console.log(`  skipped, nothing it covers changed: ${describe(c)}`);
    if (picked.changed?.length) {
        console.log(`\nOut of date: ${picked.changed.join(", ")} changed since these were saved. Work them out again and save them with --save (it replaces them).`);
    }
    else if (picked.saved?.broken) {
        console.log(`\nLast run, ${picked.saved.broken.check} could not run (${picked.saved.broken.reason}). Work them out again and save them with --save.`);
    }
    else if (run.length && !strangers.length) {
        console.log(`\nStart them in the background: node "${shellPath(process.argv[1])}" --repo "${root}"`);
    }
    askFirst();
    process.exit(0);
}
if (strangers.length && !args.trust) {
    console.log(`Not started: ${strangerText()}. Ask the user first, then run again with --trust.`);
    process.exit(4);
}
if (strangers.length) {
    const authors = [...new Set([...(readJson(trustFile)?.authors ?? []), ...strangers.map((a) => a.email)])];
    writeJson(trustFile, { version: 1, authors });
    console.log(`Trusting for this repo from now on: ${strangers.map((a) => a.label).join(", ")} (--forget removes this)`);
}
if (running(readRun())) {
    console.log(`Checks are already running for this repo (pid ${readRun().pid}). Wait for them with --wait.`);
    process.exit(0);
}
const { run: checks, skipped } = select(picked.checks);
if (!checks.length) {
    console.log(picked.source ? "Nothing to run: no check covers the changed files." : "No checks for this repo yet. See --plan.");
    process.exit(0);
}
console.log(`Checks from ${picked.source}`);
for (const c of skipped)
    console.log(`Skipping ${c.name}: nothing it covers changed`);
if (picked.changed?.length)
    console.log(`warning: ${picked.changed.join(", ")} changed since these checks were saved; they may be out of date`);
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
async function runCheck({ name, command, timeout }) {
    const r = await runShell(command, { cwd: root, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, timeoutMs: (timeout ?? args.timeout) * 1000 });
    if (r.error)
        return { name, command, status: "failed", exitCode: null, durationMs: r.durationMs, outputTail: r.error };
    const lines = stripAnsi(r.output).trimEnd().split(/\r?\n/);
    return {
        name,
        command,
        status: r.timedOut ? "timeout" : r.code === 0 ? "passed" : "failed",
        exitCode: r.timedOut ? null : r.code,
        durationMs: r.durationMs,
        outputTail: lines.slice(-TAIL_LINES).join("\n"),
    };
}
// Written after every check, so --wait and build.mjs see the run's progress.
const headSha = git("rev-parse", "HEAD");
const startedAt = new Date().toISOString();
const results = [];
const save = (status) => {
    const run = status === "running"
        ? { version: 1, status, pid: process.pid, startedAt, headSha, checks: checks.map((c) => c.name), results }
        : { version: 1, status, startedAt, ranAt: new Date().toISOString(), headSha, results };
    writeFileSync(`${out}.${process.pid}.tmp`, JSON.stringify(run, null, 2));
    replaceFile(`${out}.${process.pid}.tmp`, out);
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
// A saved command that no longer exists (a renamed script, an uninstalled tool) marks the saved checks
// broken, so the next --plan asks for them to be worked out again.
if (picked.saved) {
    const missing = /command not found|missing script|not recognized as an internal or external command|unknown command/i;
    const broken = results.find((r) => r.exitCode === 127 || missing.test(r.outputTail));
    if (broken) {
        const reason = broken.outputTail.split("\n").find((line) => missing.test(line))?.trim() ?? `exit code ${broken.exitCode}`;
        writeJson(savedFile, { ...picked.saved, broken: { check: broken.name, reason, at: new Date().toISOString() } });
        console.log(`\n${broken.name} could not run (${reason}). The saved checks are marked out of date.`);
    }
}
