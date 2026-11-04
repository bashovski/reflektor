import { CircleDashed, FlaskConical } from "lucide-react";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { Card, cx, SectionTitle, shortPath } from "./ui";

const tone = (pct: number) => (pct === 100 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500");

export const Coverage = () => {
  const { bundle, jumpTo } = useReport();
  const coverage = bundle.diff.coverage;
  const gaps = bundle.report.testing?.gaps ?? [];
  if (!coverage && !gaps.length) return null;

  const rows = coverage
    ? Object.entries(coverage.files)
        .map(([path, f]) => ({ path, covered: f.covered.length, total: f.covered.length + f.uncovered.length, first: f.uncovered[0] }))
        .filter((r) => r.total > 0)
        .map((r) => ({ ...r, pct: Math.round((r.covered / r.total) * 100) }))
        .sort((a, b) => a.pct - b.pct || b.total - a.total)
    : [];

  return (
    <div id="coverage">
      <SectionTitle>
        <span className="inline-flex items-center gap-2">
          <FlaskConical className="size-4" /> Tests
        </span>
      </SectionTitle>
      <Card className="grid gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {coverage && coverage.percent != null && (
          <div>
            <p className="text-3xl font-semibold tabular-nums">{coverage.percent}%</p>
            <p className="mb-4 text-sm text-zinc-500">
              of new lines run during tests ({coverage.covered} of {coverage.covered + coverage.uncovered}). Lines like comments and types do not count.
            </p>
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <li key={r.path}>
                  <button
                    type="button"
                    onClick={() => jumpTo({ path: r.path, line: r.first })}
                    className="grid w-full grid-cols-[minmax(0,1fr)_80px_44px] items-center gap-3 rounded-md px-1.5 py-1 text-left hover:bg-zinc-500/10"
                  >
                    <span className="truncate font-mono text-xs" title={r.path}>
                      {shortPath(r.path, 3)}
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-zinc-500/15">
                      <span className={cx("block h-full rounded-full", tone(r.pct))} style={{ width: `${r.pct}%` }} />
                    </span>
                    <span className="text-right text-xs text-zinc-500 tabular-nums">{r.pct}%</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-zinc-400">
              Source: {coverage.sources.map((s) => `${s.format} (${s.file})`).join(", ")}, made{" "}
              {new Date(coverage.sources[0]?.modified ?? Date.now()).toLocaleString()}
            </p>
            {coverage.sources.some((s) => s.stale) && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                The coverage file is older than the latest change, so these numbers may not match the code.
              </p>
            )}
          </div>
        )}
        {gaps.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-semibold">Missing tests</p>
            <ul className="space-y-2">
              {gaps.map((g, i) => (
                <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
                  <CircleDashed className="mt-1 size-3.5 shrink-0 text-amber-500" />
                  <RichText text={g} className="block min-w-0" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
};
