#!/usr/bin/env node
// Takes screenshots of the changed UI with Playwright and writes screenshots.json for the report. A subagent runs it in
// the background while the report is written (skill/screenshots.md), and the review page shows each shot as it is taken.
//
// The agent works out what to show and writes a capture plan: sets of shots, each a flow (screens in order), the
// states of one page, or a single change, with a caption per shot. This script only follows the plan, so the next
// round can run the same plan again without working it out anew.
//
// Playwright is the project's own (playwright, @playwright/test or playwright-core in the repo), else a global install,
// else PR_REPORT_PLAYWRIGHT (a package folder, for tests). Its Chromium must be installed.
//
// Usage: node screenshots.mjs --repo . --status              the setting, Playwright, the app and what to run next
//        node screenshots.mjs --detect                       Playwright and Chromium on this machine, as JSON (the daemon)
//        node screenshots.mjs --repo . --save --url <url> [--start "<command>"] [--ready <seconds>] [--host <name>]... --source "<where from>" --from <file>...
//        node screenshots.mjs --repo . --share               copy the saved app settings into .pr-report.json
//        node screenshots.mjs --repo . --forget              delete the saved app settings
//        node screenshots.mjs --repo . --prepare [--trust]   reach or start the app, then run the preScreenshots hook
//        node screenshots.mjs --repo . --inspect <path> [--auth signed-in]   print a page's accessibility tree, save a look at it
//        node screenshots.mjs --repo . --inspect --plan <plan.json> --after <set>:<step>   the same, after a set's steps up to that one
//        node screenshots.mjs --repo . --login --plan <plan.json>            sign in with the hook's test credentials
//        node screenshots.mjs --repo . --run --plan <plan.json>              take the shots, run the hooks, stop the app
//        node screenshots.mjs --repo . --skip "<reason>"     record that no shots were taken, and why
//        node screenshots.mjs --repo . --stop                stop an app this script started
//
// The app runs the branch's code and the hooks run the project's scripts, so the trust rule of the checks applies:
// with commits by authors the user has not trusted, --prepare refuses until it is run with --trust.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright-core";
import type { DiffData, HookName, Ref, RepoConfig, ScreenshotsConfig, Shot, ShotAuth, ShotSet, ShotShape } from "../schema/types.js";
import { runHooks } from "./hooks.mjs";
import { replaceFile, repoHome, reportDir, shellPath, startShell, stopTree, untrustedAuthors } from "./repo.mjs";
import type { ScreenshotsFile } from "./screenshots-run.mjs";
import { readSettings } from "./settings.mjs";

const MAX_SHOTS = 12;
const VIEWPORT = { width: 1280, height: 800 };
const INSTALL = { playwright: "npm install -g playwright", chromium: "npx playwright install chromium" };

type Mode = "status" | "detect" | "save" | "share" | "forget" | "prepare" | "inspect" | "login" | "run" | "skip" | "stop";
type Args = { mode: Mode; repo: string; url: string | null; start: string | null; ready: number | null; hosts: string[]; source: string | null; from: string[]; path: string | null; auth: ShotAuth; plan: string | null; after: string | null; reason: string | null; trust: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "status", repo: ".", url: null, start: null, ready: null, hosts: [], source: null, from: [], path: null, auth: "signed-out", plan: null, after: null, reason: null, trust: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--repo") args.repo = next();
    else if (a === "--url") args.url = next();
    else if (a === "--start") args.start = next();
    else if (a === "--ready") args.ready = Number(next());
    else if (a === "--host") args.hosts.push(next());
    else if (a === "--source") args.source = next();
    else if (a === "--from") args.from.push(next());
    else if (a === "--plan") args.plan = next();
    else if (a === "--trust") args.trust = true;
    else if (a === "--auth") {
      const value = next();
      if (value !== "signed-in" && value !== "signed-out") throw new Error(`--auth is signed-in or signed-out, got: ${value}`);
      args.auth = value;
    } else if (a === "--inspect") {
      args.mode = "inspect";
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.path = next();
    } else if (a === "--after") {
      args.after = next();
    } else if (a === "--skip") {
      args.mode = "skip";
      args.reason = next();
    } else if (["--status", "--detect", "--save", "--share", "--forget", "--prepare", "--login", "--run", "--stop"].includes(a)) args.mode = a.slice(2) as Mode;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};
const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  replaceFile(`${file}.${process.pid}.tmp`, file);
};
const quiet = (cmd: string, argv: string[], cwd?: string): string | null => {
  try {
    return execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true, shell: process.platform === "win32" && cmd !== "git" }).trim();
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ Playwright on this machine

type Found = { from: "repo" | "global" | "env"; name: string; dir: string; version: string | null; core: string | null };
const NAMES = ["playwright", "@playwright/test", "playwright-core"];

// A package's folder from the folder something requires it from, or null.
const packageDir = (fromDir: string, name: string): string | null => {
  try {
    return dirname(createRequire(join(fromDir, "noop.js")).resolve(`${name}/package.json`));
  } catch {
    return null;
  }
};
const versionOf = (dir: string): string | null => readJson<{ version?: string }>(join(dir, "package.json"))?.version ?? null;

// playwright-core, which has the browsers: the package itself, or what it depends on. @playwright/test depends on
// playwright, which depends on playwright-core.
function coreOf(name: string, dir: string): string | null {
  if (name === "playwright-core") return dir;
  if (name === "@playwright/test") {
    const playwright = packageDir(dir, "playwright");
    return playwright ? packageDir(playwright, "playwright-core") : null;
  }
  return packageDir(dir, "playwright-core");
}

// Folders that may hold the project's Playwright: the repo root, and in a pnpm workspace the store under it, where a
// package of one of the apps keeps it.
function repoCandidates(root: string): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  for (const name of NAMES) {
    const dir = packageDir(root, name);
    if (dir) found.push({ name, dir });
  }
  const store = join(root, "node_modules", ".pnpm");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const name = NAMES.find((n) => entry.startsWith(`${n.replace("/", "+")}@`));
      const dir = name && join(store, entry, "node_modules", name);
      if (dir && existsSync(join(dir, "package.json"))) found.push({ name, dir });
    }
  }
  return found;
}

let globalRoots: string[] | null = null;
const globalCandidates = (): { name: string; dir: string }[] => {
  globalRoots ??= [quiet("npm", ["root", "-g"]), quiet("pnpm", ["root", "-g"])].filter((d): d is string => Boolean(d));
  return globalRoots.flatMap((rootDir) => NAMES.map((name) => ({ name, dir: join(rootDir, name) }))).filter((c) => existsSync(join(c.dir, "package.json")));
};

function findPlaywright(root: string | null): Found | null {
  const env = process.env.PR_REPORT_PLAYWRIGHT;
  const lists: [Found["from"], { name: string; dir: string }[]][] = [
    ["env", env ? [{ name: readJson<{ name?: string }>(join(env, "package.json"))?.name ?? "playwright-core", dir: env }] : []],
    ["repo", root ? repoCandidates(root) : []],
    ["global", globalCandidates()],
  ];
  for (const [from, list] of lists) {
    for (const { name, dir } of list) {
      const core = coreOf(name, dir);
      if (core) return { from, name, dir, version: versionOf(dir), core };
    }
  }
  return null;
}

const loadChromium = (found: Found): BrowserType => (createRequire(join(found.core!, "noop.js"))(found.core!) as { chromium: BrowserType }).chromium;

// The browser to take the shots with: Playwright's own Chromium, else the Google Chrome installed on this machine,
// which Playwright drives as the "chrome" channel. PR_REPORT_CHROME names another Chrome, for tests.
const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"],
  win32: [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d!, "Google", "Chrome", "Application", "chrome.exe")),
};
const systemChrome = (): string | null => [process.env.PR_REPORT_CHROME, ...(CHROME_PATHS[process.platform] ?? [])].find((p): p is string => Boolean(p && existsSync(p))) ?? null;

type BrowserChoice = { kind: "chromium" } | { kind: "chrome"; path: string };
const browserFor = (found: Found): BrowserChoice | null => {
  if (chromiumInstalled(found)) return { kind: "chromium" };
  const chrome = systemChrome();
  return chrome ? { kind: "chrome", path: chrome } : null;
};

// The full Chromium, or the headless shell that headless runs use since Playwright 1.49.
function chromiumInstalled(found: Found): boolean {
  try {
    const full = loadChromium(found).executablePath();
    if (existsSync(full)) return true;
    const browsers = full.split(/[\\/]chromium-\d+[\\/]/)[0];
    const revision = full.match(/chromium-(\d+)/)?.[1];
    return Boolean(revision && existsSync(join(browsers, `chromium_headless_shell-${revision}`)));
  } catch {
    return false;
  }
}

if (args.mode === "detect") {
  const found = findPlaywright(null);
  console.log(
    JSON.stringify({
      playwright: { found: Boolean(found), version: found?.version ?? null, from: found?.from ?? null },
      chromium: { found: found ? chromiumInstalled(found) : false },
      chrome: { found: Boolean(systemChrome()) },
      install: INSTALL,
    }),
  );
  process.exit(0);
}

// ------------------------------------------------------------------ this repo and its report folder

const git = (...argv: string[]): string => execFileSync("git", argv, { cwd: resolve(args.repo), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = git("rev-parse", "--show-toplevel");
const gitDir = resolve(root, git("rev-parse", "--git-dir"));
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const dir = reportDir(gitDir, branch);
const runFile = join(dir, "screenshots.json");
const shotsDir = join(dir, "shots");
const work = join(dir, "screenshots");
const files = {
  plan: join(work, "plan.json"),
  app: join(work, "app.json"),
  appLog: join(work, "app.log"),
  auth: join(work, "auth.json"),
  state: join(work, "auth-state.json"),
  credentials: join(work, "auth-credentials.json"),
  inspect: join(work, "inspect"),
};
const configFile = join(root, ".pr-report.json");
const savedFile = join(repoHome(root), "screenshots.json");
const trustFile = join(repoHome(root), "trust.json");
const diff = readJson<DiffData>(join(dir, "diff.json"));
const script = shellPath(process.argv[1]);
const cmd = (rest: string) => `node "${script}" --repo "${shellPath(root)}" ${rest}`;

// ------------------------------------------------------------------ the app's address and how to start it

type SavedApp = { version: 1; savedAt: string; source: string | null; from: Record<string, string | null>; config: ScreenshotsConfig };
const hashOf = (file: string): string | null => {
  try {
    return createHash("sha1").update(readFileSync(join(root, file))).digest("hex");
  } catch {
    return null;
  }
};

function appConfig(): { config: ScreenshotsConfig; source: string; changed: string[] } | null {
  const shared = readJson<RepoConfig>(configFile)?.screenshots;
  if (shared?.url) return { config: shared, source: ".pr-report.json", changed: [] };
  const saved = readJson<SavedApp>(savedFile);
  if (!saved?.config?.url) return null;
  const changed = Object.entries(saved.from ?? {}).filter(([file, hash]) => hashOf(file) !== hash).map(([file]) => file);
  return { config: saved.config, source: `saved for this repo on ${new Date(saved.savedAt).toLocaleDateString("en-CA")}${saved.source ? `, ${saved.source}` : ""}`, changed };
}

if (args.mode === "save") {
  if (!args.url) throw new Error("--save needs --url, the address the app answers at");
  const url = new URL(args.url).toString().replace(/\/$/, "");
  const config: ScreenshotsConfig = { url, ...(args.start ? { start: args.start } : {}), ...(args.ready ? { readySeconds: args.ready } : {}), ...(args.hosts.length ? { hosts: args.hosts } : {}) };
  const from = Object.fromEntries(args.from.map((file) => [file, hashOf(file)]));
  writeJson(savedFile, { version: 1, savedAt: new Date().toISOString(), source: args.source, from, config });
  console.log(`Saved the app for screenshots of this repo in ${shellPath(savedFile)}:`);
  console.log(`  address: ${url}${config.start ? `\n  start:   ${config.start}` : ""}`);
  console.log("--forget deletes it; --share copies it into .pr-report.json for the team.");
  process.exit(0);
}
if (args.mode === "forget") {
  console.log(existsSync(savedFile) ? `Deleted ${shellPath(savedFile)}` : "No app is saved for this repo.");
  rmSync(savedFile, { force: true });
  process.exit(0);
}
if (args.mode === "share") {
  const saved = readJson<SavedApp>(savedFile);
  if (!saved?.config?.url) {
    console.log("No app is saved for this repo.");
    process.exit(0);
  }
  writeJson(configFile, { ...(readJson<RepoConfig>(configFile) ?? {}), screenshots: saved.config });
  console.log(`Copied the app settings into ${shellPath(configFile)}. Commit it to share them.`);
  process.exit(0);
}

// Where the browser may go: localhost, names under .localhost and .test, the app's own host and the configured ones.
const allowedHost = (config: ScreenshotsConfig) => {
  const extra = new Set([new URL(config.url!).hostname, ...(config.hosts ?? [])].map((h) => h.toLowerCase()));
  return (host: string) => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".test") || extra.has(h);
  };
};

const answers = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
};

const appStarted = () => readJson<{ pid: number; url: string; startedAt: string }>(files.app);
function stopApp(): boolean {
  const app = appStarted();
  if (!app) return false;
  stopTree(app.pid);
  rmSync(files.app, { force: true });
  return true;
}

if (args.mode === "stop") {
  console.log(stopApp() ? "Stopped the app this script started." : "No app started by this script is running.");
  process.exit(0);
}

// ------------------------------------------------------------------ screenshots.json

const headSha = () => git("rev-parse", "HEAD");
const now = () => new Date().toISOString();
const readRun = () => readJson<ScreenshotsFile>(runFile);
const writeRun = (run: Omit<ScreenshotsFile, "version" | "updatedAt">) => writeJson(runFile, { version: 1, ...run, updatedAt: now() });

async function afterHooks(result: "passed" | "failed", appUrl: string | null) {
  const env: Record<string, string> = {
    PR_REPORT_SCREENSHOTS: runFile,
    PR_REPORT_SCREENSHOTS_RESULT: result,
    PR_REPORT_SCREENSHOTS_DIR: shotsDir,
    ...(appUrl ? { PR_REPORT_APP_URL: appUrl } : {}),
  };
  const run = (name: HookName) => runHooks(name, { root, branch, base: diff?.branch.base ?? readJson<RepoConfig>(configFile)?.base ?? null, env });
  await run(result === "passed" ? "onScreenshotsPassed" : "onScreenshotsFailed");
  await run("postScreenshots");
}

async function skip(reason: string, appUrl: string | null = null): Promise<never> {
  writeRun({ status: "done", result: "failed", startedAt: readRun()?.startedAt ?? now(), ranAt: now(), headSha: headSha(), skipped: reason, sets: [] });
  console.log(`No screenshots: ${reason}`);
  await afterHooks("failed", appUrl);
  stopApp();
  process.exit(0);
}

if (args.mode === "skip") await skip(args.reason ?? "The agent skipped them.");

// ------------------------------------------------------------------ status

const settingOn = readSettings().screenshots;
const playwright = findPlaywright(root);
const strangers = untrustedAuthors(root, [diff?.branch.base, "origin/HEAD", "origin/main", "origin/master", "main", "master"]) ?? [];
const hookCommands = (name: HookName) => {
  const value = readJson<RepoConfig>(configFile)?.hooks?.[name];
  return (Array.isArray(value) ? value : [value]).filter((c): c is string => typeof c === "string" && Boolean(c.trim()));
};

if (args.mode === "status") {
  const app = appConfig();
  console.log(`Screenshots setting: ${settingOn ? "on" : "off (turned on in the page's Settings, under Screenshots)"}`);
  if (playwright) {
    console.log(`Playwright: ${playwright.name} ${playwright.version ?? ""} (${playwright.from === "repo" ? "the project's own" : playwright.from === "global" ? "global install" : "PR_REPORT_PLAYWRIGHT"}) at ${shellPath(playwright.dir)}`);
    const choice = browserFor(playwright);
    console.log(
      choice?.kind === "chromium" ? "Browser: Playwright's Chromium" : choice ? "Browser: Google Chrome (Playwright's Chromium is not installed)" : `Browser: none. The user installs Playwright's Chromium with: ${INSTALL.chromium}`,
    );
  } else {
    console.log(`Playwright: not found in the repo or globally. The user installs it with: ${INSTALL.playwright}, then ${INSTALL.chromium}`);
  }
  if (app) {
    console.log(`App: ${app.config.url} (${app.source})${app.config.start ? `, started with: ${app.config.start}` : ", never started by this script"}`);
    if (app.changed.length) console.log(`  Out of date: ${app.changed.join(", ")} changed since it was saved. Check it and save it again with --save.`);
  } else {
    console.log("App: none saved. Work out once where the app answers and how to start it (package.json scripts, the dev server's config), then save it:");
    console.log(`  ${cmd('--save --url http://localhost:5173 --start "pnpm dev" --source "<where from>" --from package.json')}`);
  }
  const pre = hookCommands("preScreenshots");
  console.log(pre.length ? `Signed-in shots: the preScreenshots hook sets up a test login (${pre.join("; ")})` : "Signed-in shots: none. Without a preScreenshots hook, only signed-out pages can be shown.");
  if (existsSync(files.plan)) console.log(`A plan from an earlier round: ${shellPath(files.plan)}. Run it again when it still covers the change.`);
  if (strangers.length) console.log(`Ask the user first: this branch has commits by ${strangers.map((a) => a.label).join(", ")}, and the app and hooks run their code. On a yes, add --trust to --prepare.`);
  process.exit(0);
}

// ------------------------------------------------------------------ the browser

type Action =
  | { goto: string }
  | { click: string }
  | { fill: [string, string] }
  | { press: string | [string, string] }
  | { select: [string, string] }
  | { check: string }
  | { uncheck: string }
  | { hover: string }
  | { waitFor: string }
  | { scroll: string | number };
type PlanStep = { do: Action[]; shot: string; refs?: string[]; fullPage?: boolean };
type PlanSet = { id: string; shape: ShotShape; title: string; summary?: string; auth: ShotAuth; steps: PlanStep[] };
type Plan = { login?: { path: string; do: Action[] }; sets: PlanSet[] };

const ACTIONS = ["goto", "click", "fill", "press", "select", "check", "uncheck", "hover", "waitFor", "scroll"];

function checkPlan(plan: Plan): string[] {
  const errors: string[] = [];
  if (!Array.isArray(plan?.sets) || !plan.sets.length) return ["the plan has no sets"];
  const ids = new Set<string>();
  let shots = 0;
  const checkActions = (where: string, list: unknown) => {
    if (!Array.isArray(list)) return errors.push(`${where}: "do" must be a list of actions`);
    for (const action of list as Record<string, unknown>[]) {
      const keys = Object.keys(action ?? {});
      if (keys.length !== 1 || !ACTIONS.includes(keys[0])) errors.push(`${where}: unknown action ${JSON.stringify(action)}; use one of ${ACTIONS.join(", ")}`);
    }
  };
  for (const [i, set] of plan.sets.entries()) {
    const where = `set ${set?.id ?? i + 1}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(set?.id ?? "")) errors.push(`${where}: id must be lowercase letters, digits and dashes`);
    else if (ids.has(set.id)) errors.push(`${where}: the id is used twice`);
    ids.add(set?.id);
    if (!["flow", "states", "single"].includes(set?.shape)) errors.push(`${where}: shape is flow, states or single`);
    if (!["signed-in", "signed-out"].includes(set?.auth)) errors.push(`${where}: auth is signed-in or signed-out`);
    if (!set?.title?.trim()) errors.push(`${where}: needs a title`);
    if (set?.shape === "flow" && !set.summary?.trim()) errors.push(`${where}: a flow needs a summary`);
    if (!Array.isArray(set?.steps) || !set.steps.length) {
      errors.push(`${where}: needs steps`);
      continue;
    }
    if (set.shape === "single" && set.steps.length !== 1) errors.push(`${where}: a single set has one step`);
    for (const [s, step] of set.steps.entries()) {
      if (!step?.shot?.trim()) errors.push(`${where}, step ${s + 1}: needs a caption in "shot"`);
      checkActions(`${where}, step ${s + 1}`, step?.do);
      shots++;
    }
  }
  if (plan.login) checkActions("login", plan.login.do);
  if (shots > MAX_SHOTS) errors.push(`the plan has ${shots} shots; keep it to ${MAX_SHOTS}`);
  return errors;
}

// "path:line" or "path", kept only for files the change touches, so a click on one always lands in the diff.
const changed = new Set((diff?.files ?? []).map((f) => f.path));
function refsOf(list: string[] | undefined, where: string): Ref[] {
  const refs: Ref[] = [];
  for (const text of (list ?? []).slice(0, 3)) {
    const m = text.match(/^(.+?)(?::(\d+))?$/);
    if (!m) continue;
    if (diff && !changed.has(m[1])) {
      console.log(`warning: ${where}: ${m[1]} is not changed by this branch; the reference is left out`);
      continue;
    }
    refs.push(m[2] ? { path: m[1], line: Number(m[2]) } : { path: m[1] });
  }
  return refs;
}

// Waits for the page to come to rest: loaded, the network quiet for a moment (or 5 seconds at most, for pages that
// keep a connection open), the fonts in, and two frames drawn.
async function settle(page: Page) {
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
}

type Session = { browser: Browser; base: string; allowed: (host: string) => boolean };

async function newPage(session: Session, auth: ShotAuth): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const storageState = auth === "signed-in" && existsSync(files.state) ? files.state : undefined;
  const context = await session.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, storageState, reducedMotion: "reduce" });
  // Pages may load fonts and scripts from anywhere, but only move to, or send data to, the allowed hosts.
  await context.route("**/*", (route, request) => {
    const host = new URL(request.url()).hostname;
    if (!session.allowed(host) && (request.isNavigationRequest() || request.method() !== "GET")) return route.abort("blockedbyclient");
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return { context, page, errors };
}

const credentials = () => readJson<{ username?: string; password?: string }>(files.credentials);
const fillIn = (text: string) => {
  const c = credentials();
  return text.replace(/\$username/g, c?.username ?? "").replace(/\$password/g, c?.password ?? "");
};

// What an action looks for, to name in an error when nothing matched in time.
const targetOf = (action: Action): string => {
  const value = Object.values(action)[0] as unknown;
  return String(Array.isArray(value) ? value[0] : value);
};

async function act(session: Session, page: Page, action: Action) {
  try {
    await perform(session, page, action);
  } catch (e) {
    if ((e as Error)?.name !== "TimeoutError") throw e;
    const [kind] = Object.keys(action);
    if (kind === "goto") throw new Error(`${targetOf(action)} did not finish loading in time`);
    // Playwright's call log says whether the selector found an element, and what kept it from acting on it then.
    const log = String((e as Error).message).split("\n");
    const found = log.some((line) => /resolved to|locator resolved/.test(line));
    const noise = /waiting for|waiting \d+ms|attempting|retrying|scrolling|element is visible, enabled and stable/;
    const reason = [...log].reverse().find((line) => /^\s*-\s/.test(line) && !noise.test(line))?.trim().replace(/^-\s*/, "");
    throw new Error(
      found ? `Found ${targetOf(action)}, but could not ${kind} it in time${reason ? `: ${reason}` : ""}` : `Nothing on the page matched ${targetOf(action)} in time (${kind})`,
    );
  }
}

async function perform(session: Session, page: Page, action: Action) {
  if ("goto" in action) {
    const target = new URL(action.goto, `${session.base}/`);
    if (!session.allowed(target.hostname)) throw new Error(`${target.hostname} is not an allowed host; add it to "hosts" in the screenshots config`);
    await page.goto(target.toString());
  } else if ("click" in action) await page.locator(action.click).click();
  else if ("fill" in action) await page.locator(action.fill[0]).fill(fillIn(action.fill[1]));
  else if ("press" in action) {
    if (Array.isArray(action.press)) await page.locator(action.press[0]).press(action.press[1]);
    else await page.keyboard.press(action.press);
  } else if ("select" in action) await page.locator(action.select[0]).selectOption(action.select[1]);
  else if ("check" in action) await page.locator(action.check).check();
  else if ("uncheck" in action) await page.locator(action.uncheck).uncheck();
  else if ("hover" in action) await page.locator(action.hover).hover();
  else if ("waitFor" in action) await page.locator(action.waitFor).first().waitFor({ state: "visible" });
  else if ("scroll" in action) {
    if (typeof action.scroll === "number") await page.mouse.wheel(0, action.scroll);
    else await page.locator(action.scroll).scrollIntoViewIfNeeded();
  }
}

// An error from Playwright as one line for the report: its first line, without the call log after it.
const short = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);

async function session(): Promise<Session> {
  const app = appConfig();
  if (!playwright) throw new Error(`Playwright was not found. Install it with ${INSTALL.playwright}, then ${INSTALL.chromium}.`);
  if (!app) throw new Error("No app is saved for screenshots. See --status.");
  if (!(await answers(app.config.url!))) throw new Error(`The app does not answer at ${app.config.url}. Run --prepare first.`);
  const choice = browserFor(playwright);
  if (!choice) throw new Error(`No browser for Playwright. Install its Chromium with ${INSTALL.chromium}.`);
  const browser = await loadChromium(playwright).launch(choice.kind === "chrome" ? { headless: true, executablePath: choice.path } : { headless: true });
  return { browser, base: app.config.url!.replace(/\/$/, ""), allowed: allowedHost(app.config) };
}

// Signs in through the app's own login page, as the plan's login steps say, with the credentials the preScreenshots
// hook wrote. "$username" and "$password" in a fill stand for them, so they never appear in the plan. The session is
// saved for every signed-in set after it.
async function login(s: Session, plan: Plan): Promise<string> {
  if (!plan.login) throw new Error('the plan has no "login" steps');
  if (!credentials()?.username) throw new Error("the preScreenshots hook wrote no test credentials");
  const { context, page } = await newPage(s, "signed-out");
  try {
    await act(s, page, { goto: plan.login.path });
    for (const action of plan.login.do) await act(s, page, action);
    await settle(page);
    await context.storageState({ path: files.state });
    return page.url();
  } finally {
    await context.close();
  }
}

const readPlan = (): Plan => {
  if (!args.plan) throw new Error("--plan <plan.json> is required");
  const plan = readJson<Plan>(resolve(args.plan));
  if (!plan) throw new Error(`Could not read the plan at ${args.plan}`);
  return plan;
};

// ------------------------------------------------------------------ prepare

if (args.mode === "prepare") {
  if (strangers.length && !args.trust) {
    console.log(`Not started: this branch has commits by ${strangers.map((a) => a.label).join(", ")}, and the app and the hooks run their code. Ask the user first, then run again with --trust.`);
    process.exit(4);
  }
  if (strangers.length) {
    const authors = [...new Set([...(readJson<{ authors?: string[] }>(trustFile)?.authors ?? []), ...strangers.map((a) => a.email)])];
    writeJson(trustFile, { version: 1, authors });
    console.log(`Trusting for this repo from now on: ${strangers.map((a) => a.label).join(", ")} (checks.mjs --forget removes this)`);
  }
  mkdirSync(work, { recursive: true });
  writeRun({ status: "preparing", result: null, startedAt: now(), ranAt: null, headSha: headSha(), skipped: null, sets: [] });
  if (!playwright) await skip(`Playwright was not found. Install it with ${INSTALL.playwright}, then ${INSTALL.chromium}.`);
  if (!browserFor(playwright!)) await skip(`Neither Playwright's Chromium nor Google Chrome is installed. Install Chromium with ${INSTALL.chromium}.`);
  const app = appConfig();
  if (!app) await skip("No app address is saved for this repo, so there was nothing to take pictures of.");
  const url = app!.config.url!;

  let started = false;
  if (!(await answers(url))) {
    if (!app!.config.start) await skip(`The app does not answer at ${url}, and no start command is saved.`, url);
    stopApp();
    const log = openSync(files.appLog, "w");
    const pid = startShell(app!.config.start!, { cwd: root, env: { ...process.env, BROWSER: "none" }, log });
    closeSync(log);
    if (!pid) await skip(`Could not start the app with: ${app!.config.start}`, url);
    writeJson(files.app, { pid, url, startedAt: now() });
    started = true;
    const limit = Date.now() + (app!.config.readySeconds ?? 60) * 1000;
    process.stdout.write(`Starting the app: ${app!.config.start} ... `);
    while (!(await answers(url))) {
      if (Date.now() > limit) {
        const tail = readFileSync(files.appLog, "utf8").trimEnd().split("\n").slice(-8).join("\n");
        console.log("no answer");
        await skip(`The app did not answer at ${url} within ${app!.config.readySeconds ?? 60} seconds of: ${app!.config.start}${tail ? `\n${tail}` : ""}`, url);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("up");
  }

  rmSync(files.state, { force: true });
  rmSync(files.credentials, { force: true });
  const hook = await runHooks("preScreenshots", {
    root,
    branch,
    base: diff?.branch.base ?? null,
    env: { PR_REPORT_APP_URL: url, PR_REPORT_SCREENSHOTS_DIR: shotsDir, PR_REPORT_AUTH_STATE: files.state, PR_REPORT_AUTH_CREDENTIALS: files.credentials },
  });
  const auth = existsSync(files.state) ? "state" : existsSync(files.credentials) ? "credentials" : null;
  writeJson(files.auth, { auth, hookFailed: hook.failed, hookRan: hook.ran > 0 });
  writeRun({ status: "preparing", result: null, startedAt: readRun()?.startedAt ?? now(), ranAt: null, headSha: headSha(), skipped: null, sets: [] });

  console.log(`App ready at ${url}${started ? " (started by this script; --run stops it)" : " (already running)"}`);
  if (auth === "state") console.log("Signed in: the preScreenshots hook saved a session, so signed-in sets and --inspect --auth signed-in use it.");
  else if (auth === "credentials") console.log(`Signed in: not yet, the hook wrote test credentials. Inspect the login page signed out, write a plan with only its "login" block ("$username" and "$password" in the fills), then run ${cmd("--login --plan <plan.json>")} before inspecting signed-in pages.`);
  else if (hook.failed) console.log("Signed in: no. The preScreenshots hook failed, so signed-in sets will be skipped.");
  else console.log("Signed in: no. There is no preScreenshots hook, so only signed-out pages can be shown.");
  console.log(`Plan file, when you were given no scratch folder: ${shellPath(files.plan)}`);
  console.log(`Next: look at the pages with ${cmd("--inspect /path [--auth signed-in]")}, write the plan, then ${cmd("--run --plan <plan.json>")}`);
  process.exit(0);
}

// ------------------------------------------------------------------ inspect and login

if (args.mode === "inspect" || args.mode === "login") {
  let s: Session;
  try {
    s = await session();
  } catch (e) {
    console.log(short(e));
    process.exit(3);
  }
  try {
    if (args.mode === "login") {
      const at = await login(s, readPlan());
      console.log(`Signed in. The page after signing in: ${at}. Signed-in sets and --inspect --auth signed-in now use this session.`);
    } else {
      // With --after, the page is where a set's steps leave it: the plan's actions up to and with that step.
      let replay: { set: PlanSet; steps: PlanStep[] } | null = null;
      if (args.after) {
        const [setId, stepText] = args.after.split(":");
        const set = readPlan().sets?.find((x) => x.id === setId);
        const upTo = Number(stepText);
        if (!set || !(upTo >= 1 && upTo <= set.steps.length)) throw new Error(`--after needs <set id>:<step number> from the plan, got ${args.after}`);
        replay = { set, steps: set.steps.slice(0, upTo) };
      } else if (!args.path) throw new Error("--inspect needs a path, or --plan with --after <set>:<step>");
      const auth = replay?.set.auth ?? args.auth;
      if (auth === "signed-in" && !existsSync(files.state)) throw new Error("No signed-in session. Run --prepare again: the hooks after a --run may have ended the last one.");
      const { context, page, errors } = await newPage(s, auth);
      if (replay) {
        for (const [n, step] of replay.steps.entries()) {
          for (const action of step.do) {
            try {
              await act(s, page, action);
            } catch (e) {
              throw new Error(`step ${n + 1}: ${short(e)}`);
            }
          }
        }
      } else await act(s, page, { goto: args.path! });
      await settle(page);
      mkdirSync(files.inspect, { recursive: true });
      const name = replay ? `${replay.set.id}-after-${replay.steps.length}` : args.path!.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "home";
      const picture = join(files.inspect, `${name}-${auth}.png`);
      await page.screenshot({ path: picture, animations: "disabled", caret: "hide" });
      const asked = replay ? null : new URL(args.path!, `${s.base}/`).pathname;
      console.log(`Address: ${page.url()}${asked && new URL(page.url()).pathname !== asked ? "  (redirected)" : ""}`);
      console.log(`Title: ${await page.title()}`);
      console.log(`Picture: ${shellPath(picture)}`);
      const tree = await page.locator("body").ariaSnapshot().catch(async () => (await page.locator("body").innerText()).slice(0, 8000));
      const lines = tree.split("\n");
      console.log(`\nAccessibility tree${lines.length > 400 ? ` (first 400 of ${lines.length} lines)` : ""}:`);
      console.log(lines.slice(0, 400).join("\n"));
      if (errors.length) console.log(`\nErrors on the page:\n${errors.slice(0, 10).map((e) => `  ${e.split("\n")[0]}`).join("\n")}`);
      await context.close();
    }
  } catch (e) {
    console.log(`Failed: ${short(e)}`);
    process.exitCode = 1;
  } finally {
    await s.browser.close();
  }
  const run = readRun();
  if (run?.status === "preparing") writeRun({ ...run });
  process.exit();
}

// ------------------------------------------------------------------ run

if (args.mode === "run") {
  let plan: Plan;
  try {
    plan = readPlan();
  } catch (e) {
    console.log(short(e));
    process.exit(2);
  }
  const errors = checkPlan(plan);
  if (errors.length) {
    console.log(`The plan has problems; fix them and run again:\n${errors.map((e) => `  ${e}`).join("\n")}`);
    process.exit(2);
  }
  mkdirSync(work, { recursive: true });
  if (resolve(args.plan!) !== files.plan) copyFileSync(resolve(args.plan!), files.plan);

  const sets: ShotSet[] = plan.sets.map((set) => ({
    id: set.id,
    shape: set.shape,
    title: set.title.trim(),
    summary: set.summary?.trim() || null,
    auth: set.auth,
    shots: set.steps.map(
      (step, i): Shot => ({
        id: `${set.id}-${i + 1}`,
        caption: step.shot.trim(),
        refs: refsOf(step.refs, `${set.id} step ${i + 1}`),
        status: "pending",
        file: null,
        width: null,
        height: null,
        error: null,
      }),
    ),
  }));
  const startedAt = now();
  const sha = headSha();
  const save = (status: "running" | "done", result: "passed" | "failed" | null = null) =>
    writeRun({ status, result, startedAt, ranAt: status === "done" ? now() : null, headSha: sha, skipped: null, sets, ...(status === "running" ? { pid: process.pid } : {}) });
  // Pictures are named by their content and earlier ones stay, so a comment on a round's picture keeps showing that
  // picture after a later round takes the shot again.
  mkdirSync(shotsDir, { recursive: true });
  save("running");

  let s: Session | null = null;
  try {
    s = await session();
  } catch (e) {
    await skip(short(e), appConfig()?.config.url ?? null);
  }
  const fail = (set: ShotSet, from: number, reason: string) => {
    for (const shot of set.shots.slice(from)) Object.assign(shot, { status: "failed", error: reason });
  };

  if (plan.sets.some((set) => set.auth === "signed-in") && !existsSync(files.state) && credentials()?.username && plan.login) {
    try {
      await login(s!, plan);
      console.log("Signed in with the test credentials.");
    } catch (e) {
      console.log(`Signing in failed: ${short(e)}`);
    }
  }

  for (const [i, set] of sets.entries()) {
    const steps = plan.sets[i].steps;
    if (set.auth === "signed-in" && !existsSync(files.state)) {
      fail(set, 0, "No signed-in session: the project needs a preScreenshots hook that sets up a test login.");
      save("running");
      continue;
    }
    const { context, page } = await newPage(s!, set.auth);
    for (const [n, step] of steps.entries()) {
      const shot = set.shots[n];
      try {
        for (const action of step.do) await act(s!, page, action);
        await settle(page);
        const png = await page.screenshot({ animations: "disabled", caret: "hide", fullPage: Boolean(step.fullPage) });
        const name = `${createHash("sha1").update(png).digest("hex").slice(0, 16)}.png`;
        const file = join(shotsDir, name);
        if (!existsSync(file)) writeFileSync(file, png);
        Object.assign(shot, { status: "taken", file: `shots/${name}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
        console.log(`taken  ${shot.id}  ${shellPath(file)}  "${shot.caption}"`);
      } catch (e) {
        Object.assign(shot, { status: "failed", error: short(e) });
        console.log(`failed ${shot.id}  ${shot.error}`);
        if (set.shape === "flow") {
          fail(set, n + 1, "An earlier step of this flow failed.");
          save("running");
          break;
        }
      }
      save("running");
    }
    await context.close();
  }
  await s!.browser.close();

  const all = sets.flatMap((set) => set.shots);
  const result = all.every((shot) => shot.status === "taken") ? "passed" : "failed";
  save("done", result);
  console.log(`\nScreenshots: ${all.filter((x) => x.status === "taken").length} of ${all.length} taken. Wrote ${shellPath(runFile)}`);
  if (result === "failed") console.log("Fix the failed steps in the plan (--inspect shows the page as it is), then run --prepare and --run again.");
  else console.log("Look at each picture and check its caption says what changed on it.");
  await afterHooks(result, appConfig()?.config.url ?? null);
  if (stopApp()) console.log("Stopped the app this script started.");
  process.exit(0);
}
