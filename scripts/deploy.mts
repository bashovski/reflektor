#!/usr/bin/env node
// Installs the package `pnpm build` made (dist/skill/) for a coding agent. Runs the same on macOS, Linux and Windows
// (PowerShell, cmd or Git Bash). It is `pnpm run deploy`: plain `pnpm deploy` is a pnpm command of its own.
//
//   pnpm run deploy                       Claude Code: link ~/.claude/skills/reflektor to dist/skill/ (each new build applies right away)
//   pnpm run deploy --copy                Claude Code: copy dist/skill/ instead; use this if a Claude Code update removed the link
//   pnpm run deploy --target agents       other agents: a copy in ~/.agents/skills/reflektor, the folder Codex and other agents
//                                         that follow the Agent Skills format read
//   pnpm run deploy --target <folder>     a copy in any other skills folder
//   pnpm run deploy --no-open             do not open the setup page in the browser after a first install
//
// --target can be given more than once (--target claude --target agents); without it the target is claude.
// A copy for another agent gets its own SKILL.md (see skill/scripts/portable-skill.mts) and is not a link, so deploy again after
// each build. On Windows the link is a directory junction, which needs no admin rights or Developer Mode.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { forgetInstall, installTarget, targetLabel } from "../skill/scripts/install.mjs";
import { root } from "./paths.mjs";

const pkg = join(root, "dist", "skill");
const mode = process.argv.includes("--copy") ? "copy" : "link";

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};
// Every report starts with git. Finding out here beats a failed first /reflektor.
if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) fail("git is required. Install it from https://git-scm.com, then run this again.");

// The package must exist and hold the source as it is now: a file changed after the build means it is not in there.
const buildFile = join(pkg, "build.json");
if (!existsSync(buildFile)) fail("dist/skill/ is not built yet. Run pnpm build first.");
const builtAt = Date.parse((JSON.parse(readFileSync(buildFile, "utf8")) as { builtAt: string }).builtAt);
const newest = (path: string): number => {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).filter((name) => name !== "node_modules").map((name) => newest(join(path, name))));
};
// skill/assets/ is left from builds before dist/ and is not part of the package.
const sources = [...readdirSync(join(root, "skill")).filter((name) => name !== "assets").map((name) => join(root, "skill", name)), join(root, "viewer", "src"), join(root, "viewer", "index.html"), join(root, "viewer", "vite.config.ts")];
if (Math.max(...sources.map(newest)) > builtAt) fail("dist/skill/ is older than the source. Run pnpm build first.");

// Where to install. `claude` is Claude Code's skills folder, `agents` the folder shared by agents that
// follow the Agent Skills format, and anything else is taken as a path to a skills folder.
const targets = process.argv.flatMap((arg, i, all) => (arg === "--target" && all[i + 1] ? [all[i + 1]] : []));
if (process.argv.includes("--target") && !targets.length) fail("--target needs a value: claude, agents, or a skills folder");
if (!targets.length) targets.push("claude");

// Installing is the skill's own install.mjs, which a release uses too. A build from a checkout is not a release, so
// install.json goes: nothing offers to update it, and the daemon does not look for new versions.
function install(name: string) {
  try {
    const t = installTarget(pkg, name, { copy: mode === "copy" });
    console.log(`Installed reflektor for ${targetLabel(t)} (${t.how}): ${t.target}`);
    return t;
  } catch (e) {
    return fail((e as Error).message);
  }
}

const installed = targets.map(install);
forgetInstall();

// A first install ends in the browser: the setup page checks the tools on this machine and picks how
// reports look. review.mjs starts the review daemon for it, from the installed skill, the same way a
// report does. A later install (an update) keeps the daemon and the browser alone.
const setupScript = join(installed[0].target, "scripts", "review.mjs");
if (installed.some((t) => t.first) && !process.argv.includes("--no-open")) {
  const r = spawnSync(process.execPath, [setupScript, "setup"], { encoding: "utf8" });
  if (r.status === 0) console.log(r.stdout.trim());
  else console.log(`Could not open the setup page (${(r.stderr || r.stdout).trim()}). Open it later with: node "${setupScript}" setup`);
} else {
  console.log(`Setup page (your tools, light or dark, code theme): node "${setupScript}" setup`);
}

console.log("");
if (installed.some((t) => t.claude)) {
  console.log("Next, in Claude Code: open it in a repo, on a branch with changes, and type /reflektor.");
  console.log("If Claude Code does not know /reflektor, start a new session. If the skill goes missing after a Claude Code update, run pnpm run deploy again, or with --copy.");
}
if (installed.some((t) => !t.claude)) {
  console.log("Next, in another agent: open it in a repo, on a branch with changes, and ask for a PR report. In Codex, type $reflektor.");
  console.log("That install is a copy: run pnpm run deploy with the same --target after each pnpm build.");
} else {
  console.log("For Codex and other agents that read ~/.agents/skills: pnpm run deploy --target agents");
}
