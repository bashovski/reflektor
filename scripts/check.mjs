#!/usr/bin/env node
// End-to-end check: rebuilds the fake books repo, runs collect.mjs and build.mjs on it with
// samples/report.json, and fails on any warning. Also refreshes samples/bundle.json for `pnpm dev`.
//
// Usage: node scripts/check.mjs [--open]

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-check-"));
const repo = join(tmp, "books");
const html = join(root, "samples", "books-report.html");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let failed = false;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failed = true;
};

try {
  run("bash", [join(root, "fixtures", "make-books-repo.sh"), repo]);

  const collected = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", repo, "--no-fetch"]);
  if (!collected.includes("Patch coverage: 51%")) fail("collect.mjs did not read coverage from .pr-report.json");
  if (!collected.includes("(config)")) fail("collect.mjs did not take the base branch from .pr-report.json");
  if (!collected.includes("Safety checks: 1 high, 0 medium, 1 low")) fail("collect.mjs safety checks did not find the slug migration problems");

  // A key-shaped value built at runtime, so no literal secret is stored in this repo.
  const secretRepo = join(tmp, "secret");
  run("bash", ["-c", `mkdir -p "${secretRepo}" && cd "${secretRepo}" && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base && git checkout -qb feat`]);
  writeFileSync(join(secretRepo, "config.js"), `export const key = "${"AKIA" + "Q".repeat(16)}";\n`);
  const secretOut = run("node", [join(root, "skill/scripts/collect.mjs"), "--repo", secretRepo, "--no-fetch", "--base", "main", "--out", join(tmp, "secret.json")]);
  if (!secretOut.includes("AWS access key [AKIA…(20 characters)]")) fail("collect.mjs did not flag or mask a fake AWS key");

  const built = run("node", [
    join(root, "skill/scripts/build.mjs"),
    "--diff", join(repo, ".git/pr-report/diff.json"),
    "--report", join(root, "samples/report.json"),
    "--json-out", join(root, "samples/bundle.json"),
    "--out", html,
  ]);
  for (const line of built.split("\n").filter((l) => l.startsWith("warning:"))) fail(line);

  const bundle = JSON.parse(readFileSync(join(root, "samples/bundle.json"), "utf8"));
  const missingIcons = bundle.diff.files.filter((f) => !bundle.fileIcons?.byPath[f.path]);
  if (missingIcons.length) fail(`no file icon for ${missingIcons.length} files (run node scripts/build-icons.mjs)`);

  const page = readFileSync(html, "utf8");
  if (page.includes("__PR_REPORT_DATA__")) fail("report data was not injected into the viewer");
  if (statSync(html).size < 1_000_000) fail("the report is too small; build.mjs probably used the unbuilt viewer");
} catch (e) {
  fail(e.stderr?.toString() || e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(`check passed: ${html}`);

if (process.argv.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [html], { detached: true, stdio: "ignore" }).unref();
}
