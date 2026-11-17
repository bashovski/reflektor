// Which reflektor this is. build.json sits next to scripts/ in the package and names the version it was built as. A
// release (scripts/pack-release.mts marks it `channel: "release"`) is that version exactly. Anything else is a build
// from a checkout and counts as a dev build: its version carries a hash of the daemon's code, so the daemon is still
// replaced the moment a rebuild changes it, as before versions existed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The package this file belongs to: scripts/ is one folder down.
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export function buildInfo(dir = SKILL_DIR) {
    try {
        return JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
    }
    catch {
        return {};
    }
}
export const isRelease = (dir = SKILL_DIR) => buildInfo(dir).channel === "release";
// A release installed with `npx skills`: it learns about new versions like any release, but `npx skills` updates it.
export const fromSkills = (dir = SKILL_DIR) => isRelease(dir) && buildInfo(dir).distribution === "skills";
export const SKILLS_UPDATE = "npx skills update reflektor";
// The version this package reports: "1.4.0" for a release, "1.4.0-dev+3f2a9c1b7e04" for a build from a checkout.
// The running package's own version is worked out once per process: its files do not change under it.
let own = null;
export function skillVersion(dir = SKILL_DIR) {
    if (dir === SKILL_DIR && own)
        return own;
    const version = readVersion(dir);
    if (dir === SKILL_DIR)
        own = version;
    return version;
}
// Read from disk every time: review.mjs compares it with the running daemon, and a build from a checkout changes under
// a long-running waiter.
export function readVersion(dir = SKILL_DIR) {
    const info = buildInfo(dir);
    if (info.channel === "release" && info.version)
        return info.version;
    let code = "";
    try {
        code = createHash("sha1").update(readFileSync(join(dir, "scripts", "daemon.mjs"))).digest("hex").slice(0, 12);
    }
    catch {
        code = "unknown";
    }
    return `${info.version ?? "0.0.0"}-dev+${code}`;
}
// ------------------------------------------------------------------ comparing
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const isVersion = (value) => typeof value === "string" && SEMVER.test(value);
export const isDevVersion = (value) => /-dev(?:[.+]|$)/.test(value);
// Below 0, equal 0, above 0, as semver orders them: a pre-release sorts before its release, and build metadata
// (after +) does not count. A string that is not a version sorts below every version.
export function compareVersions(a, b) {
    const x = SEMVER.exec(a);
    const y = SEMVER.exec(b);
    if (!x || !y)
        return x ? 1 : y ? -1 : 0;
    for (let i = 1; i <= 3; i++) {
        const d = Number(x[i]) - Number(y[i]);
        if (d)
            return d;
    }
    if (!x[4] || !y[4])
        return x[4] ? -1 : y[4] ? 1 : 0;
    const p = x[4].split(".");
    const q = y[4].split(".");
    for (let i = 0; i < Math.max(p.length, q.length); i++) {
        if (p[i] === undefined)
            return -1;
        if (q[i] === undefined)
            return 1;
        const m = /^\d+$/.test(p[i]);
        const n = /^\d+$/.test(q[i]);
        if (m && n) {
            const d = Number(p[i]) - Number(q[i]);
            if (d)
                return d;
        }
        else if (m !== n)
            return m ? -1 : 1;
        else if (p[i] !== q[i])
            return p[i] < q[i] ? -1 : 1;
    }
    return 0;
}
