#!/usr/bin/env node
// Puts a pr-report package in place for one or more agents, and keeps track of which release is installed. It ships
// inside the skill, so an installed skill can update itself without the repo: the daemon and `review.mjs update` call
// activate(), install.sh and install.ps1 run this file after unpacking a release, and the repo's deploy.mts uses
// installTarget() for a build from a checkout.
//
//   claude     Claude Code: ~/.claude/skills/pr-report, a link (a junction on Windows) to the package
//   agents     agents that read ~/.agents/skills (Codex and others): a copy with its own SKILL.md (portable-skill.mjs)
//   <folder>   any other skills folder: a copy, like agents
//
// A release lives in ~/.pr-report/versions/<version>/, one folder per version, so an update never writes over files a
// running daemon or script is using: it unpacks the new version next to the old one and moves the links.
// ~/.pr-report/install.json names the release in use, the one before it (for rollback) and the targets. A build from
// a checkout has no install.json, which is how the daemon knows not to look for updates.
//
//   node install.mjs activate [--target claude|agents|<folder>]... [--no-open]
//     installs the package this file belongs to (a release unpacked into versions/) for the targets given, or for the
//     targets of the install before it, or for Claude Code

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { portableSkillText } from "./portable-skill.mjs";
import { HOME, VERSIONS_DIR, versionDir } from "./release.mjs";
import { replaceFile } from "./repo.mjs";
import { buildInfo, compareVersions, SKILL_DIR } from "./version.mjs";

export type InstallFile = { version: string; targets: string[]; installedAt: string; previous: string | null };
export type Installed = { name: string; claude: boolean; target: string; how: "link" | "copy"; first: boolean };

export const INSTALL_FILE = join(HOME, "install.json");

export function readInstall(): InstallFile | null {
  try {
    const value = JSON.parse(readFileSync(INSTALL_FILE, "utf8")) as Partial<InstallFile>;
    if (typeof value.version !== "string" || !Array.isArray(value.targets)) return null;
    return { version: value.version, targets: value.targets.filter((t): t is string => typeof t === "string"), installedAt: String(value.installedAt ?? ""), previous: typeof value.previous === "string" ? value.previous : null };
  } catch {
    return null;
  }
}

const writeInstall = (value: InstallFile) => {
  mkdirSync(HOME, { recursive: true });
  const tmp = `${INSTALL_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  replaceFile(tmp, INSTALL_FILE);
};

// A build from a checkout (deploy.mts) is not a release: it removes install.json so nothing tries to update it.
export const forgetInstall = () => rmSync(INSTALL_FILE, { force: true });

// The skills folder a target name stands for.
export function skillsFolder(name: string): string {
  if (name === "claude") return process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  if (name === "agents") return process.env.AGENTS_SKILLS_DIR ?? join(homedir(), ".agents", "skills");
  return resolve(name);
}

// Installs the package in `pkg` for one target. Only Claude Code can use a package as it is, so only it gets a link
// (unless `copy`); any other agent needs its own SKILL.md and gets a copy. A link from an earlier install is removed
// as a link. A folder is removed only when it is this skill, and never when it resolves to the package itself.
// Throws with a sentence for the reader when the target is something else.
export function installTarget(pkg: string, name: string, { copy = false } = {}): Installed {
  const claude = name === "claude";
  const skills = skillsFolder(name);
  const target = join(skills, "pr-report");
  const how = claude && !copy ? "link" : "copy";
  mkdirSync(skills, { recursive: true });

  let existing = null;
  try {
    existing = lstatSync(target);
  } catch {
    // Not installed yet.
  }
  if (existing?.isSymbolicLink()) unlinkSync(target);
  else if (existing) {
    const skillFile = join(target, "SKILL.md");
    if (!existsSync(skillFile) || !/^name: pr-report$/m.test(readFileSync(skillFile, "utf8"))) throw new Error(`${target} exists and is not this skill. Move it away first.`);
    if (realpathSync(target) === realpathSync(pkg)) throw new Error(`${target} points at the package itself. Remove that link by hand, then run this again.`);
    rmSync(target, { recursive: true, force: true });
  }

  if (how === "link") symlinkSync(pkg, target, "junction");
  else cpSync(pkg, target, { recursive: true });
  if (!claude) writeFileSync(join(target, "SKILL.md"), portableSkillText(readFileSync(join(pkg, "SKILL.md"), "utf8"), target));
  return { name, claude, target, how, first: existing === null };
}

export const targetLabel = (t: Installed) => (t.claude ? "Claude Code" : t.name === "agents" ? "agents that read ~/.agents/skills" : t.name);

// Makes an unpacked release the one in use, for `targets` (else the targets of the install before it, else Claude
// Code), and records it in install.json with the version it replaces.
export function activate(version: string, targets?: string[]): { installed: Installed[]; previous: string | null } {
  const pkg = versionDir(version);
  if (buildInfo(pkg).version !== version) throw new Error(`pr-report ${version} is not unpacked in ${pkg}.`);
  const before = readInstall();
  const names = targets?.length ? targets : before?.targets.length ? before.targets : ["claude"];
  const installed = names.map((name) => installTarget(pkg, name));
  const previous = before && before.version !== version ? before.version : (before?.previous ?? null);
  writeInstall({ version, targets: names, installedAt: new Date().toISOString(), previous });
  return { installed, previous };
}

// Back to the release before this one. Throws when there is none, or it was removed.
export function rollback(): { version: string; installed: Installed[] } {
  const now = readInstall();
  if (!now?.previous) throw new Error("There is no earlier pr-report release to go back to.");
  if (buildInfo(versionDir(now.previous)).version !== now.previous) throw new Error(`pr-report ${now.previous} is no longer on this machine.`);
  const { installed } = activate(now.previous, now.targets);
  return { version: now.previous, installed };
}

// Removes every unpacked version but the ones in use and before it, the version this process runs from, and leftovers
// of an unpack that is still going (an hour's grace).
export function prune(keep: string[] = []) {
  const install = readInstall();
  const kept = new Set([...keep, install?.version, install?.previous, buildInfo(SKILL_DIR).version].filter(Boolean));
  let names: string[] = [];
  try {
    names = readdirSync(VERSIONS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(VERSIONS_DIR, name);
    if (name.startsWith(".")) {
      try {
        if (Date.now() - statSync(path).mtimeMs < 3_600_000) continue;
      } catch {
        continue;
      }
    } else if (kept.has(name)) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

// Newest first, for `review.mjs version`.
export const unpackedVersions = () => {
  try {
    return readdirSync(VERSIONS_DIR)
      .filter((name) => !name.startsWith(".") && buildInfo(join(VERSIONS_DIR, name)).version === name)
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
};

// ------------------------------------------------------------------ run by install.sh and install.ps1

// realpath on both sides: a release under /var on macOS runs as /private/var.
if (process.argv[1] && process.argv[2] === "activate" && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(3);
  const targets = argv.flatMap((arg, i, all) => (arg === "--target" && all[i + 1] ? [all[i + 1]] : []));
  const version = buildInfo(SKILL_DIR).version;
  try {
    if (!version) throw new Error(`${SKILL_DIR} has no build.json with a version.`);
    const { installed } = activate(version, targets);
    for (const t of installed) console.log(`Installed pr-report ${version} for ${targetLabel(t)} (${t.how}): ${t.target}`);
    const review = join(versionDir(version), "scripts", "review.mjs");
    if (installed.some((t) => t.first) && !argv.includes("--no-open")) {
      const r = spawnSync(process.execPath, [review, "setup"], { encoding: "utf8" });
      if (r.status === 0) console.log(r.stdout.trim());
      else console.log(`Could not open the setup page (${(r.stderr || r.stdout).trim()}). Open it later with: node "${review}" setup`);
    }
    console.log("");
    if (installed.some((t) => t.claude)) console.log("Next, in Claude Code: open it in a repo, on a branch with changes, and type /pr-report. Start a new session if it does not know /pr-report yet.");
    if (installed.some((t) => !t.claude)) console.log("Next, in another agent: open it in a repo, on a branch with changes, and ask for a PR report. In Codex, type $pr-report.");
    console.log("pr-report tells you when a new version is out, and updates from the report's menu.");
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
