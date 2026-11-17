// Reads a screenshots.json written by screenshots.mjs, for build.mjs and the daemon.
// "stopped" when the run's process is gone before it finished (killed or crashed), or when a run that is getting the
// app ready has not been heard from for a long time, since that step runs in several short commands with no process
// of its own to watch.
import { readFileSync } from "node:fs";
const QUIET_MS = 20 * 60_000;
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
export function readScreenshotsRun(file) {
    let data;
    try {
        data = JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
    let status = data.status;
    if (status === "running" && !alive(data.pid))
        status = "stopped";
    if (status === "preparing" && Date.now() - Date.parse(data.updatedAt ?? data.startedAt ?? "") > QUIET_MS)
        status = "stopped";
    return {
        status,
        result: data.result ?? null,
        startedAt: data.startedAt ?? null,
        ranAt: data.ranAt ?? null,
        headSha: data.headSha ?? "",
        skipped: data.skipped ?? null,
        sets: data.sets ?? [],
    };
}
