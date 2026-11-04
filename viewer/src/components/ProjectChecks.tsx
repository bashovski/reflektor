import { CircleCheck, CircleX, Clock, TerminalSquare } from "lucide-react";
import type { CheckStatus } from "../../../skill/schema/types";
import { useReport } from "../lib/state";
import { cx } from "./ui";

const STATUS: Record<CheckStatus, { label: string; icon: typeof CircleCheck; className: string }> = {
  passed: { label: "Passed", icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", icon: CircleX, className: "text-red-600 dark:text-red-400" },
  timeout: { label: "Timed out", icon: Clock, className: "text-amber-600 dark:text-amber-400" },
};

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// Results of the project's own lint, typecheck and test commands, run by checks.mjs.
export const ProjectChecks = () => {
  const { bundle } = useReport();
  const checks = bundle.projectChecks;
  if (!checks?.results.length) return null;
  const failed = checks.results.filter((r) => r.status !== "passed").length;

  return (
    <section id="project-checks" className="surface rounded-xl border p-4 sm:p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <TerminalSquare className={cx("size-4", failed ? "text-red-500" : "text-emerald-500")} />
        Project checks
        <span className="font-normal text-zinc-500">
          {checks.results.length - failed} of {checks.results.length} passed
        </span>
      </h2>
      <p className="mb-3 text-xs text-zinc-500">
        Your project's own commands, run {new Date(checks.ranAt).toLocaleString()}.
        {checks.stale && <span className="text-amber-600 dark:text-amber-400"> The code changed after this run, so results may be out of date.</span>}
      </p>
      <ul className="space-y-1.5">
        {checks.results.map((r) => {
          const meta = STATUS[r.status];
          const Icon = meta.icon;
          const row = (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className={cx("inline-flex w-[88px] shrink-0 items-center gap-1.5 text-xs font-medium", meta.className)}>
                <Icon className="size-3.5" />
                {meta.label}
              </span>
              <span className="shrink-0 text-sm font-medium">{r.name}</span>
              <code className="min-w-0 truncate font-mono text-xs text-zinc-500">{r.command}</code>
              <span className="ml-auto shrink-0 text-xs text-zinc-400 tabular-nums">{seconds(r.durationMs)}</span>
            </span>
          );
          if (r.status === "passed") {
            return (
              <li key={r.name} className="flex px-2 py-1">
                {row}
              </li>
            );
          }
          return (
            <li key={r.name}>
              <details open className="rounded-lg border border-red-500/25 bg-red-500/[0.04]">
                <summary className="flex cursor-pointer list-none px-2 py-1.5">{row}</summary>
                <pre className="max-h-72 overflow-auto border-t border-red-500/20 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                  {r.outputTail || "(no output)"}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
