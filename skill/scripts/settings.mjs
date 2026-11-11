// The reader's settings that the agent has to know about.
//
// How the page looks (theme, code theme, diff view) is kept in the browser, where only the page needs it. These are
// kept on disk, in ~/.pr-report/settings.json, because the scripts read them: the page writes them through the
// daemon (/api/settings), and collect.mjs tells the agent what they say.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const FILE = join(HOME, "settings.json");

// Every setting with the value it has until someone changes it. A key that is not listed here is never read or
// written, and a value of the wrong type counts as not set.
const DEFAULTS = {
  // Split the reading and writing of a report between subagents that work at the same time. Faster, and it costs
  // more tokens, so it is off until the reader turns it on. SKILL.md step 4b says what the agent does with it.
  subagents: false,
};

export function readSettings() {
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // No file yet, or one that cannot be read: the defaults stand.
  }
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, typeof saved?.[key] === typeof fallback ? saved[key] : fallback]));
}

// Takes the known keys out of `patch`, saves them over what was there, and returns all settings.
export function writeSettings(patch) {
  const next = readSettings();
  for (const [key, fallback] of Object.entries(DEFAULTS)) if (typeof patch?.[key] === typeof fallback) next[key] = patch[key];
  mkdirSync(HOME, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
