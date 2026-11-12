// Hooks: shell commands a project names in .pr-report.json, run at fixed points of a report. They come
// with the repo, so everyone who clones it gets them, and the scripts run them, so every agent does.
//
//   preRun      collect.mjs, before it fetches and reads the changes. A failure stops the report.
//   postRun     review.mjs open, at the first publish of a round that is not a draft. A failure is a warning.
//   onApproved  review.mjs wait or resume, when the reviewer finishes with nothing left to fix. A failure is a warning.
//
// A hook is one command or a list, run one after another in the repo's root, in the same shell as the
// project checks (repo.mjs runShell). A failing command ends its list, and so does the time limit below.
// What a hook prints is shown to the agent. The daemon and the page never run a command.
//
// Every hook gets PR_REPORT_HOOK (its name), PR_REPORT_BRANCH and PR_REPORT_BASE. postRun and onApproved
// also get PR_REPORT_ROUND, PR_REPORT_DIFF (diff.json: the git facts, with full file contents),
// PR_REPORT_REPORT (report.json: what the agent wrote), PR_REPORT_URL (the review page) and, when the
// build wrote one, PR_REPORT_PR_TEXT (pr-description.md: the title line, then the body). The two files'
// types are DiffData and Report in schema/types.ts.
//
// Hooks run code from the branch (.pr-report.json and the scripts it names), so they follow the checks'
// trust rule: when the branch has commits by someone the user has not trusted for this repo
// (checks.mjs --trust), they do not run. Nor do they when the base cannot be found, since then nobody
// can tell whose commits are on the branch.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffData, HookName, RepoConfig } from "../schema/types.js";
import { remoteOf, runShell, untrustedAuthors } from "./repo.mjs";

// Code generation in preRun can be slow; the others should be quick. PR_REPORT_HOOK_SECONDS overrides
// all three, for tests.
const LIMIT_SECONDS: Record<HookName, number> = { preRun: 300, postRun: 120, onApproved: 120 };

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// The commands for one hook: a string or a list of strings in "hooks" of .pr-report.json.
export function hookCommands(config: RepoConfig | null | undefined, name: HookName): string[] {
  const value = config?.hooks?.[name];
  return (Array.isArray(value) ? value : [value]).filter((c): c is string => typeof c === "string" && Boolean(c.trim()));
}

// Runs one hook's commands and prints a line for each, followed by what it printed.
// Returns { ran, failed }: how many commands ran, and whether one failed or timed out.
export async function runHooks(
  name: HookName,
  {
    root,
    branch,
    base,
    config = readJson(join(root, ".pr-report.json")) as RepoConfig | null,
    env = {},
    log = console.log,
  }: { root: string; branch: string | null; base: string | null | undefined; config?: RepoConfig | null; env?: Record<string, string>; log?: (text: string) => void },
): Promise<{ ran: number; failed: boolean }> {
  const commands = hookCommands(config, name);
  if (!commands.length) return { ran: 0, failed: false };

  const remote = remoteOf(root);
  const strangers = base ? untrustedAuthors(root, [remote && `${remote}/${base}`, base]) : null;
  if (!strangers) {
    log(`Hooks skipped (${name}): the base branch${base ? ` ${base}` : ""} was not found, so it is unknown whose commits are on this branch.`);
    return { ran: 0, failed: false };
  }
  if (strangers.length) {
    log(
      `Hooks skipped (${name}): this branch has commits by ${strangers.map((a) => a.label).join(", ")}, and hooks run the branch's code. ` +
        "They run once the user trusts these authors for this repo (checks.mjs --trust).",
    );
    return { ran: 0, failed: false };
  }

  const seconds = Number(process.env.PR_REPORT_HOOK_SECONDS) || LIMIT_SECONDS[name];
  const hookEnv = { ...process.env, PR_REPORT_HOOK: name, PR_REPORT_BRANCH: branch ?? "", PR_REPORT_BASE: base!, ...env };
  let ran = 0;
  for (const command of commands) {
    const r = await runShell(command, { cwd: root, env: hookEnv, timeoutMs: seconds * 1000 });
    ran++;
    const problem = r.error ? `could not start (${r.error})` : r.timedOut ? `timed out after ${seconds}s` : r.code !== 0 ? `failed with exit code ${r.code}` : null;
    log(problem ? `Hook ${name} ${problem}: ${command}` : `Hook ${name}: ${command} (${(r.durationMs / 1000).toFixed(1)}s)`);
    const printed = r.output.trimEnd();
    if (printed) log(printed.split(/\r?\n/).map((line) => `  ${line}`).join("\n"));
    if (problem) return { ran, failed: true };
  }
  return { ran, failed: false };
}

// A hook for a published round, handed the report's files. The repo, branch and base come from the
// diff.json in the report folder the daemon names.
export async function runReportHooks(
  name: HookName,
  { dir, round, url, log }: { dir: string; round: number; url: string; log?: (text: string) => void },
): Promise<{ ran: number; failed: boolean }> {
  const diffFile = join(dir, "diff.json");
  const diff = readJson(diffFile) as DiffData | null;
  if (!diff?.repo?.root) return { ran: 0, failed: false };
  const prText = join(dir, "pr-description.md");
  return runHooks(name, {
    root: diff.repo.root,
    branch: diff.branch.head,
    base: diff.branch.base,
    log,
    env: {
      PR_REPORT_ROUND: String(round),
      PR_REPORT_DIFF: diffFile,
      PR_REPORT_REPORT: join(dir, "report.json"),
      PR_REPORT_URL: url,
      ...(existsSync(prText) ? { PR_REPORT_PR_TEXT: prText } : {}),
    },
  });
}
