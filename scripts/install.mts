#!/usr/bin/env node
// Builds the viewer and installs the pr-report skill for a coding agent. Runs the same on macOS, Linux
// and Windows (PowerShell, cmd or Git Bash).
//
//   node scripts/install.mts                    Claude Code: link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
//   node scripts/install.mts --copy             Claude Code: copy skill/ instead; use this if a Claude Code update removed the link
//   node scripts/install.mts --target agents    other agents: a copy in ~/.agents/skills/pr-report, the folder Codex and other agents
//                                               that follow the Agent Skills format read
//   node scripts/install.mts --target <folder>  a copy in any other skills folder
//   node scripts/install.mts --build            only build the viewer into skill/assets/
//   node scripts/install.mts --no-open          do not open the setup page in the browser after a first install
//
// --target can be given more than once (--target claude --target agents); without it the target is claude.
// A copy for another agent gets its own SKILL.md (see portable-skill.mts) and is not a link, so run the
// installer again after updating pr-report. On Windows the link is a directory junction, which needs no
// admin rights or Developer Mode.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { portableSkillText } from "./portable-skill.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--build") ? "build" : process.argv.includes("--copy") ? "copy" : "link";

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
// The scripts are TypeScript (.mts) that Node runs directly, without a flag from 22.18. An older Node that runs this
// file with --experimental-strip-types would install a skill that agents cannot start.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) fail(`Node.js 22.18 or newer is required (this is ${process.version})`);
// Every report starts with git. Finding out here beats a failed first /pr-report.
if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) fail("git is required. Install it from https://git-scm.com, then run this again.");

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
node(join(root, "scripts", "build-icons.mts"));
sh(pnpm ? "pnpm build" : "npm run build", viewer);
mkdirSync(assets, { recursive: true });
rmSync(join(assets, "app"), { recursive: true, force: true });
cpSync(join(viewer, "dist", "app"), join(assets, "app"), { recursive: true });
cpSync(join(viewer, "dist", "standalone", "index.html"), join(assets, "viewer.html"));
// The inbox search (served by the daemon at /fuse.mjs).
cpSync(join(viewer, "node_modules", "fuse.js", "dist", "fuse.basic.min.mjs"), join(assets, "fuse.mjs"));
if (mode === "build") {
  console.log(`Built ${assets}`);
  process.exit(0);
}

// Where to install. `claude` is Claude Code's skills folder, `agents` the folder shared by agents that
// follow the Agent Skills format, and anything else is taken as a path to a skills folder.
const targets = process.argv.flatMap((arg, i, all) => (arg === "--target" && all[i + 1] ? [all[i + 1]] : []));
if (process.argv.includes("--target") && !targets.length) fail("--target needs a value: claude, agents, or a skills folder");
if (!targets.length) targets.push("claude");
const source = join(root, "skill");

function install(name) {
  const claude = name === "claude";
  const skills = claude
    ? (process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills"))
    : name === "agents"
      ? (process.env.AGENTS_SKILLS_DIR ?? join(homedir(), ".agents", "skills"))
      : resolve(name);
  const target = join(skills, "pr-report");
  // Only Claude Code can use skill/ as it is. Another agent needs its own SKILL.md, so it gets a copy.
  const how = claude ? mode : "copy";
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

  if (how === "link") symlinkSync(source, target, "junction");
  else cpSync(source, target, { recursive: true });
  if (!claude) writeFileSync(join(target, "SKILL.md"), portableSkillText(readFileSync(join(source, "SKILL.md"), "utf8"), target));

  console.log(`Installed pr-report for ${claude ? "Claude Code" : name === "agents" ? "agents that read ~/.agents/skills" : name} (${how}): ${target}`);
  return { claude, target, first: existing === null };
}

const installed = targets.map(install);

// A first install ends in the browser: the setup page checks the tools on this machine and picks how
// reports look. review.mts starts the review daemon for it, from the installed skill, the same way a
// report does. A later install (an update) keeps the daemon and the browser alone.
const setupScript = join(installed[0].target, "scripts", "review.mts");
if (installed.some((t) => t.first) && !process.argv.includes("--no-open")) {
  const r = spawnSync(process.execPath, [setupScript, "setup"], { encoding: "utf8" });
  if (r.status === 0) console.log(r.stdout.trim());
  else console.log(`Could not open the setup page (${(r.stderr || r.stdout).trim()}). Open it later with: node "${setupScript}" setup`);
} else {
  console.log(`Setup page (your tools, light or dark, code theme): node "${setupScript}" setup`);
}

console.log("");
if (installed.some((t) => t.claude)) {
  console.log("Next, in Claude Code: open it in a repo, on a branch with changes, and type /pr-report.");
  console.log("If Claude Code does not know /pr-report, start a new session. If the skill goes missing after a Claude Code update, run this installer again or use --copy.");
}
if (installed.some((t) => !t.claude)) {
  console.log("Next, in another agent: open it in a repo, on a branch with changes, and ask for a PR report. In Codex, type $pr-report.");
  console.log("That install is a copy: run this installer again with the same --target after updating pr-report.");
} else {
  console.log("For Codex and other agents that read ~/.agents/skills: node scripts/install.mts --target agents");
}
