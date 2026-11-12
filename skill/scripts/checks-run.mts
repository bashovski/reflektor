// Reads a checks.json written by checks.mjs, for build.mjs and the daemon.
// "running" while its process lives, "stopped" when the process is gone before the last check
// ended (killed or crashed), "done" after. Files from older versions have no status: done.

import { readFileSync } from "node:fs";
import type { ChecksRun, ProjectCheck } from "../schema/types.js";

// checks.json as checks.mjs writes it: pid and checks only while it runs, ranAt only once it is done.
type ChecksFile = { status?: "running" | "done"; pid?: number; startedAt?: string; ranAt?: string; headSha?: string; checks?: string[]; results?: ProjectCheck[] };

const alive = (pid: number | undefined): boolean => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};

export function readChecksRun(file: string): ChecksRun | null {
  let data: ChecksFile;
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as ChecksFile;
  } catch {
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
