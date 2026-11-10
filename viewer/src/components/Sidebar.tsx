import { Braces, Check, FlaskConical, Route } from "lucide-react";
import { useEffect, useState } from "react";
import { REVIEW, SECTIONS } from "../lib/meta";
import { sectionDomId, useReport } from "../lib/state";
import { cx, Digit, Meter } from "./ui";

// The section under the sticky top bar right now, so the path can mark where the reader is. Sections
// far off screen may not be mounted, so the check takes the last mounted one whose top has passed the line.
const useActiveSection = (indexes: number[]) => {
  const [active, setActive] = useState<number | null>(null);
  const key = indexes.join(",");
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      let found: number | null = null;
      for (const i of indexes) {
        const el = document.getElementById(sectionDomId(i));
        if (el && el.getBoundingClientRect().top <= 96) found = i;
      }
      setActive(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
};

export const Sidebar = () => {
  const { bundle, isViewed, viewedCount, setSectionOpen, shownSections } = useReport();
  const { report, diff } = bundle;
  const total = diff.stats.files;
  const active = useActiveSection(shownSections.map((s) => s.index));

  const goToSection = (index: number) => {
    setSectionOpen(index, true);
    requestAnimationFrame(() => document.getElementById(sectionDomId(index))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <nav className="sticky top-[72px] space-y-6 text-sm">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="label-caps text-xs text-zinc-500">Review path</span>
          <span className="text-xs text-zinc-500 tabular-nums">
            {viewedCount}/{total}
          </span>
        </div>
        <Meter value={viewedCount} total={total} fill="bg-emerald-500" className="h-1.5" />
      </div>

      <ol className="space-y-0.5">
        {shownSections.map(({ section: s, index: i, paths }) => {
          const done = paths.filter((p) => isViewed(p)).length;
          const complete = done === paths.length;
          const current = active === i;
          const level = REVIEW[s.review];
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => goToSection(i)}
                aria-current={current ? "step" : undefined}
                className={cx("group flex w-full flex-col gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-zinc-500/10", current && "bg-zinc-500/[0.08]")}
              >
                <span className="flex w-full items-center gap-2.5">
                  <span
                    title={level.label}
                    className={cx("flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", complete ? "bg-emerald-500 text-white" : level.badge)}
                  >
                    {complete ? <Check className="size-3" /> : <Digit>{i + 1}</Digit>}
                  </span>
                  <span className={cx("min-w-0 flex-1 truncate", current && "font-medium", complete && "text-zinc-400 line-through decoration-zinc-400/50")}>
                    {s.title ?? SECTIONS[s.kind].label}
                  </span>
                  <span className="w-7 shrink-0 text-right text-[11px] text-zinc-400 tabular-nums">
                    {done}/{paths.length}
                  </span>
                </span>
                {/* How much of this section is viewed, a dash for each file, in the level's color until it is complete. */}
                <Meter value={done} total={paths.length} fill={complete ? "bg-emerald-500" : level.rail} className="ml-[30px] h-0.5 w-[calc(100%-30px)]" />
              </button>
            </li>
          );
        })}
        {report.flows.length > 0 && (
          <li className="pt-3 pb-1 pl-2 label-caps text-[11px] text-zinc-400">How it works</li>
        )}
        {report.flows.map((f) => (
          <li key={f.id}>
            <a href={`#flow-${f.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-500/10 text-zinc-500">
                <Route className="size-3" />
              </span>
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
            </a>
          </li>
        ))}
      </ol>

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
    </nav>
  );
};
