import { Braces, Check, FlaskConical, Route } from "lucide-react";
import { REVIEW, SECTIONS } from "../lib/meta";
import { sectionDomId, useReport } from "../lib/state";
import { cx, Kbd } from "./ui";

export const Sidebar = () => {
  const { bundle, isViewed, viewedCount, setSectionOpen, shownSections } = useReport();
  const { report, diff } = bundle;
  const total = diff.stats.files;
  const pct = total ? Math.round((viewedCount / total) * 100) : 0;

  const goToSection = (index: number) => {
    setSectionOpen(index, true);
    requestAnimationFrame(() => document.getElementById(sectionDomId(index))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <nav className="sticky top-[72px] space-y-6 text-sm">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-zinc-500">Review path</span>
          <span className="text-xs text-zinc-500 tabular-nums">
            {viewedCount}/{total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-500/15">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="space-y-0.5">
        {shownSections.map(({ section: s, index: i, paths }) => {
          const done = paths.filter((p) => isViewed(p)).length;
          const complete = done === paths.length;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => goToSection(i)}
                className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-zinc-500/10"
              >
                <span
                  className={cx(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                    complete ? "bg-emerald-500 text-white" : "bg-zinc-500/10 text-zinc-500",
                  )}
                >
                  {complete ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={cx("min-w-0 flex-1 truncate", complete && "text-zinc-400 line-through decoration-zinc-400/50")}>
                  {s.title ?? SECTIONS[s.kind].label}
                </span>
                <span className={cx("size-1.5 shrink-0 rounded-full", REVIEW[s.review].dot)} title={REVIEW[s.review].label} />
                <span className="w-7 shrink-0 text-right text-[11px] text-zinc-400 tabular-nums">
                  {done}/{paths.length}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {report.flows.length > 0 && (
        <div className="space-y-1">
          <span className="block px-2 text-[13px] font-semibold uppercase tracking-wide text-zinc-500">Flows</span>
          {report.flows.map((f) => (
            <a key={f.id} href={`#flow-${f.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
              <Route className="size-3.5" />
              {f.title}
            </a>
          ))}
        </div>
      )}

      {!!report.contracts?.length && (
        <a href="#contracts" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
          <Braces className="size-3.5" />
          {report.contracts.length} {report.contracts.length === 1 ? "type or constant" : "types and constants"}
        </a>
      )}

      {diff.coverage?.percent != null && (
        <a href="#coverage" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
          <FlaskConical className="size-3.5" />
          Tests run {diff.coverage.percent}% of new lines{diff.coverage.sources.some((s) => s.stale) && " (old coverage file)"}
        </a>
      )}

      <ul className="flex flex-wrap gap-x-3 gap-y-1.5 px-2 text-xs text-zinc-400">
        {(
          [
            [["j", "k"], "next file"],
            [["v"], "viewed"],
            [["f"], "full file"],
            [["?"], "settings"],
          ] as const
        ).map(([keys, label]) => (
          <li key={label} className="inline-flex items-center gap-1">
            {keys.map((k) => (
              <Kbd key={k} name={k} />
            ))}
            <span className="ml-0.5">{label}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
};
