#!/usr/bin/env node
// Builds the viewer and installs the pr-report skill for Claude Code. Runs the same on macOS, Linux
// and Windows (PowerShell, cmd or Git Bash).
//
//   node scripts/install.mjs          link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
//   node scripts/install.mjs --copy   copy skill/ instead; use this if a Claude Code update removed the link
//   node scripts/install.mjs --build  only build the viewer into skill/assets/
//
// On Windows the link is a directory junction, which needs no admin rights or Developer Mode.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--build") ? "build" : process.argv.includes("--copy") ? "copy" : "link";

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
if (Number(process.versions.node.split(".")[0]) < 18) fail("Node.js 18 or newer is required");

// pnpm and npm are .cmd files on Windows, which only start through a shell. The commands are fixed
// strings, so nothing from outside reaches the shell.
const sh = (command, cwd) => {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (r.status !== 0) fail(`${command} failed in ${cwd}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
};
const node = (script) => {
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`${script} failed\n${r.stdout ?? ""}${r.stderr ?? ""}`);
};

const viewer = join(root, "viewer");
const assets = join(root, "skill", "assets");
const pnpm = spawnSync("pnpm --version", { shell: true, stdio: "ignore" }).status === 0;
console.log(`Building the viewer with ${pnpm ? "pnpm" : "npm, since pnpm was not found"}...`);
sh(pnpm ? "pnpm install --frozen-lockfile" : "npm install", viewer);
node(join(root, "scripts", "build-icons.mjs"));
sh(pnpm ? "pnpm build" : "npm run build", viewer);
mkdirSync(assets, { recursive: true });
rmSync(join(assets, "app"), { recursive: true, force: true });
cpSync(join(viewer, "dist", "app"), join(assets, "app"), { recursive: true });
cpSync(join(viewer, "dist", "standalone", "index.html"), join(assets, "viewer.html"));
if (mode === "build") {
  console.log(`Built ${assets}`);
  process.exit(0);
}

const skills = process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
const target = join(skills, "pr-report");
const source = join(root, "skill");
mkdirSync(skills, { recursive: true });

// A link from an earlier install is removed as a link. A copy is removed only when it is this skill,
// and never when it resolves to this repo's own skill/ folder.
let existing = null;
try {
  existing = lstatSync(target);
} catch {
  // Not installed yet.
}
if (existing?.isSymbolicLink()) unlinkSync(target);
else if (existing) {
  const skillFile = join(target, "SKILL.md");
  if (!existsSync(skillFile) || !/^name: pr-report$/m.test(readFileSync(skillFile, "utf8"))) fail(`${target} exists and is not this skill. Move it away first.`);
  if (realpathSync(target) === realpathSync(source)) fail(`${target} points at this repo's skill/ folder. Remove that link by hand, then run this again.`);
  rmSync(target, { recursive: true, force: true });
}

if (mode === "link") symlinkSync(source, target, "junction");
else cpSync(source, target, { recursive: true });

console.log(`Installed pr-report (${mode}): ${target}`);
console.log("Try it in any repo: /pr-report");
