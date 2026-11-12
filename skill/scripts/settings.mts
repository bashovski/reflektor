// The reader's settings that the agent has to know about.
//
// How the page looks (theme, code theme, diff view) is kept in the browser, where only the page needs it. These are
// kept on disk, in ~/.pr-report/settings.json, because the scripts read them: the page writes them through the
// daemon (/api/settings), and collect.mts tells the agent what they say.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { replaceFile } from "./repo.mts";

const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
const FILE = join(HOME, "settings.json");

// Every setting with the value it has until someone changes it. A key that is not listed here is never read or
// written, and a value of the wrong type counts as not set.
const DEFAULTS = {
  // Split the reading and writing of a report between subagents that work at the same time. Faster, and it costs
  // more tokens, so it is off until the reader turns it on. skill/subagents.md says what the agent does with it.
  subagents: false,
};

// `base` with the values `from` has for the same keys, where they are of the same type. The file and what the page
// sends both go through it, so neither can add a key or change a type.
const known = (from, base) => Object.fromEntries(Object.entries(base).map(([key, value]) => [key, typeof from?.[key] === typeof value ? from[key] : value]));

export function readSettings() {
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // No file yet, or one that cannot be read: the defaults stand.
  }
  return known(saved, DEFAULTS);
}

// Saves the known keys of `patch` over what was there, and returns all settings.
export function writeSettings(patch) {
  const next = known(patch, readSettings());
  mkdirSync(HOME, { recursive: true });
  // Written beside the file and moved into place, so a script that reads at that moment never gets half a file.
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  replaceFile(tmp, FILE);
  return next;
}
