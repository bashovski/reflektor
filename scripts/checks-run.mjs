// Reads a checks.json written by checks.mjs, for build.mjs and the daemon.
// "running" while its process lives, "stopped" when the process is gone before the last check
// ended (killed or crashed), "done" after. Files from older versions have no status: done.
import { readFileSync } from "node:fs";
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
export function readChecksRun(file) {
    let data;
    try {
        data = JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
    const results = data.results ?? [];
    const unfinished = data.status === "running";
    return {
        status: !unfinished ? "done" : alive(data.pid) ? "running" : "stopped",
        startedAt: data.startedAt ?? null,
        ranAt: data.ranAt ?? null,
        headSha: data.headSha ?? "",
        results,
        pending: unfinished ? (data.checks ?? []).filter((name) => !results.some((r) => r.name === name)) : [],
    };
}
