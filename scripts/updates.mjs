// Knowing about new versions. The daemon asks Reflektor once an hour (GET <api>/skill/version) and keeps the
// answer in ~/.reflektor/update.json; the pages and review.mjs read it from there.
//
// The file holds only what Reflektor said and what the reader did, never "an update is needed": that would be wrong
// the moment the version changes. The status is worked out on every read, from the file and the running version:
//
//   required    the running version is below Reflektor's minimum: publishing is refused until it is updated
//   available   a newer release is out
//   none        up to date, or nothing known yet
//
// "Later" snoozes one version for a day. A newer release than the snoozed one asks again at once, and a required
// update ignores the snooze. Builds from a checkout never look for updates (REFLEKTOR_UPDATE_CHECK=1 makes one look,
// for trying the modal), and neither does a machine where install.json is missing, unless `npx skills` installed this
// release: then it looks, and the reader updates with `npx skills update reflektor` instead of from the page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readInstall } from "./install.mjs";
import { HOME } from "./release.mjs";
import { replaceFile } from "./repo.mjs";
import { compareVersions, fromSkills, isRelease, isVersion, SKILLS_UPDATE, skillVersion } from "./version.mjs";
export const UPDATE_FILE = join(HOME, "update.json");
export const CHECK_EVERY_MS = 60 * 60_000;
const SNOOZE_MS = 24 * 60 * 60_000;
const CALL_MS = 10_000;
const EMPTY = { checkedAt: null, etag: null, latest: null, minimum: null, notes: [], notesUrl: null, publishedAt: null, snoozed: null, lastError: null };
export function readUpdateFile() {
    try {
        return { ...EMPTY, ...JSON.parse(readFileSync(UPDATE_FILE, "utf8")) };
    }
    catch {
        return { ...EMPTY };
    }
}
export function writeUpdateFile(patch) {
    const next = { ...readUpdateFile(), ...patch };
    const tmp = `${UPDATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    replaceFile(tmp, UPDATE_FILE);
    return next;
}
// A release installed with install.sh or by an update, running as the version install.json names.
export const managedInstall = () => isRelease() && readInstall() !== null;
export const checksEnabled = (env = process.env) => env.REFLEKTOR_UPDATE_CHECK === "1" || (env.REFLEKTOR_UPDATE_CHECK !== "0" && (managedInstall() || fromSkills()));
export const updateCommand = () => (managedInstall() ? null : fromSkills() ? SKILLS_UPDATE : null);
export function updateInfo(file = readUpdateFile(), current = skillVersion(), at = Date.now()) {
    const known = checksEnabled();
    const below = (v) => Boolean(v && isVersion(v) && compareVersions(current, v) < 0);
    const status = !known ? "none" : below(file.minimum) ? "required" : below(file.latest) ? "available" : "none";
    const snoozed = Boolean(file.snoozed && file.snoozed.version === file.latest && Date.parse(file.snoozed.until) > at);
    return {
        current,
        latest: file.latest,
        minimum: file.minimum,
        status,
        notes: file.notes,
        notesUrl: file.notesUrl,
        snoozed,
        prompt: status === "required" || (status === "available" && !snoozed),
        managed: managedInstall(),
        command: updateCommand(),
        checkedAt: file.checkedAt,
    };
}
export const snooze = (version, at = Date.now()) => writeUpdateFile({ snoozed: { version, until: new Date(at + SNOOZE_MS).toISOString() } });
// One check against Reflektor. Answers whether the status the pages show changed. A failure keeps the last good answer
// and only notes why.
export async function checkForUpdate(apiUrl) {
    const before = updateInfo();
    const file = readUpdateFile();
    let res;
    try {
        res = await fetch(`${apiUrl}/skill/version`, {
            headers: { accept: "application/json", "user-agent": "reflektor", "x-reflektor-version": skillVersion(), ...(file.etag ? { "if-none-match": file.etag } : {}) },
            signal: AbortSignal.timeout(CALL_MS),
        });
    }
    catch (e) {
        writeUpdateFile({ lastError: e.message });
        return false;
    }
    if (res.status === 304) {
        writeUpdateFile({ checkedAt: new Date().toISOString(), lastError: null });
        return false;
    }
    if (!res.ok) {
        writeUpdateFile({ lastError: `HTTP ${res.status}` });
        return false;
    }
    const body = (await res.json().catch(() => null));
    if (!body) {
        writeUpdateFile({ lastError: "not JSON" });
        return false;
    }
    const version = (v) => (isVersion(v) ? v : null);
    writeUpdateFile({
        checkedAt: new Date().toISOString(),
        etag: res.headers.get("etag"),
        latest: version(body.latest),
        minimum: version(body.minimum),
        notes: Array.isArray(body.notes) ? body.notes.filter((n) => typeof n === "string").slice(0, 3) : [],
        notesUrl: typeof body.notesUrl === "string" && /^https:\/\//.test(body.notesUrl) ? body.notesUrl : null,
        publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : null,
        lastError: null,
    });
    const after = updateInfo();
    return after.status !== before.status || after.latest !== before.latest || after.minimum !== before.minimum;
}
// Reflektor refused a publish as too old (426): it named the minimum, which counts until the next check says otherwise.
export const noteMinimum = (minimum) => (isVersion(minimum) ? writeUpdateFile({ minimum }) : readUpdateFile());
// The line review.mjs ends its answers with while an update is waiting, for the agent to pass on once.
export function terminalLine(info = updateInfo()) {
    const how = info.command ? `Update it with: ${info.command}` : "Update from the report's menu, or run review.mjs update.";
    if (info.status === "required")
        return `Publishing needs reflektor ${info.minimum} or newer (this is ${info.current}). ${how}`;
    if (info.status === "available")
        return `reflektor ${info.latest} is available (this is ${info.current}). ${how}`;
    return null;
}
