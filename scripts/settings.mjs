// The reader's settings that the agent has to know about.
//
// How the page looks (theme, code theme, diff view) is kept in the browser, where only the page needs it. These are
// kept on disk, in ~/.reflektor/settings.json, because the scripts and the daemon read them: the page writes them
// through the daemon (/api/settings), collect.mjs tells the agent what they say, and the daemon and review.mjs read
// the Reflektor ones (reflektor.mjs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { replaceFile } from "./repo.mjs";
const HOME = process.env.REFLEKTOR_HOME ?? join(homedir(), ".reflektor");
const FILE = join(HOME, "settings.json");
const DEFAULTS = {
    // Split the reading and writing of a report between subagents that work at the same time. Faster, and it costs
    // more tokens, so it is off until the reader turns it on. skill/subagents.md says what the agent does with it.
    subagents: false,
    // Take screenshots of the changed UI with Playwright, in the background, while the report is written. Off until the
    // reader turns it on in the setup wizard or in Settings. skill/screenshots.md says what the agent does with it.
    screenshots: false,
    // Publish a branch's report to Reflektor when its pull request is open, and each later round while it stays open.
    // It does nothing until the reader signs in to Reflektor (review.mjs login), so on by default means on once signed in.
    reflektorAutoPublish: true,
    // The Reflektor API and app to sign in with. Empty means Reflektor's own (api.reflektor.dev, reflektor.dev), and the
    // REFLEKTOR_API_URL and REFLEKTOR_APP_URL variables win over both. A login keeps the URLs it was made with.
    reflektorApiUrl: "",
    reflektorAppUrl: "",
};
// `base` with the values `from` has for the same keys, where they are of the same type. The file and what the page
// sends both go through it, so neither can add a key or change a type.
const known = (from, base) => {
    const given = (from ?? {});
    return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, typeof given[key] === typeof value ? given[key] : value]));
};
export function readSettings() {
    let saved = null;
    try {
        saved = JSON.parse(readFileSync(FILE, "utf8"));
    }
    catch {
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
