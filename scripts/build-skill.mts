#!/usr/bin/env node
// Builds the pr-report skill into dist/skill/: the package an agent installs, which `pnpm run deploy` puts in place.
// skill/ holds the source and nothing is built into it. dist/ is never committed.
//
//   dist/skill/SKILL.md and the rest    copied from skill/ as they are, the schema included (build.mjs reads it)
//   dist/skill/scripts/*.mjs            skill/scripts/*.mts compiled by tsc (tsconfig.skill.json), for Node 18
//   dist/skill/assets/                  the viewer (app/ for the daemon, viewer.html for --html), Fuse.js, file icons
//   dist/skill/build.json               when it was built and from which commit, for deploy's freshness check
//
// Usage: pnpm build (node scripts/build-skill.mts). Runs the same on macOS, Linux and Windows.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = join(root, "viewer");
const source = join(root, "skill");
const out = join(root, "dist", "skill");

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};
// These tools are TypeScript that Node runs directly, which it does without a flag from 22.18. The skill they build
// is plain JavaScript and runs on Node 18.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) fail(`building pr-report needs Node.js 22.18 or newer (this is ${process.version}). The skill it builds runs on Node 18.`);

// pnpm and npm are .cmd files on Windows, which only start through a shell. The commands are fixed
// strings, so nothing from outside reaches the shell.
const sh = (command: string, cwd: string) => {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (r.status !== 0) fail(`${command} failed in ${cwd}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
};
const node = (...args: string[]) => {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`node ${args.join(" ")} failed\n${r.stdout ?? ""}${r.stderr ?? ""}`);
};

const pnpm = spawnSync("pnpm --version", { shell: true, stdio: "ignore" }).status === 0;
console.log(`Installing the viewer's packages with ${pnpm ? "pnpm" : "npm, since pnpm was not found"}...`);
sh(pnpm ? "pnpm install --frozen-lockfile" : "npm install", viewer);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The source files, as they are. The scripts are left out (step 2 compiles them), and so is skill/assets/, where
// builds before dist/ put the viewer.
const skip = [join(source, "scripts"), join(source, "assets")];
cpSync(source, out, { recursive: true, filter: (path) => !skip.some((dir) => path === dir || path.startsWith(dir + sep)) });

// 2. The scripts: tsc checks them and writes one .mjs per .mts file. Only the scripts are copied over; the schema it
// also compiles stays behind, since the package ships the schema itself.
console.log("Compiling the scripts for Node 18...");
const compiled = join(root, "dist", ".tsc");
rmSync(compiled, { recursive: true, force: true });
node(join(viewer, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.skill.json"));
cpSync(join(compiled, "scripts"), join(out, "scripts"), { recursive: true });
rmSync(compiled, { recursive: true, force: true });

// 3. The viewer: the app the daemon serves, the standalone page build.mjs --html writes, the inbox's scripts (in app/),
// Fuse.js for the inbox search, and the file type icons.
console.log("Building the viewer...");
node(join(root, "scripts", "build-icons.mts"));
sh(pnpm ? "pnpm build" : "npm run build", viewer);
const assets = join(out, "assets");
cpSync(join(viewer, "dist", "app"), join(assets, "app"), { recursive: true });
cpSync(join(viewer, "dist", "standalone", "index.html"), join(assets, "viewer.html"));
cpSync(join(viewer, "node_modules", "fuse.js", "dist", "fuse.basic.min.mjs"), join(assets, "fuse.mjs"));

// 4. When and from what it was built. deploy refuses a package older than the source.
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || null;
writeFileSync(join(out, "build.json"), `${JSON.stringify({ builtAt: new Date().toISOString(), commit }, null, 2)}\n`);

console.log(`Built ${out}`);
console.log("Install it with: pnpm run deploy");
