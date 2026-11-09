import { CircleX, Clock, FileCode2, FlaskConical, GitBranch, GitCommitHorizontal, Inbox, Loader2, Settings } from "lucide-react";
import { useChecks } from "../lib/checks";
import { BASE_SOURCE, REVIEW, TARGETS } from "../lib/meta";
import { usePr } from "../lib/pr";
import { useReport } from "../lib/state";
import { OwnerMenu } from "./OwnerMenu";
import { PrDescription } from "./PrDescription";
import { PrStatePill } from "./PullRequest";
import { UserMenu } from "./UserMenu";
import { Dot, LocCount, Pill, TagPill } from "./ui";

export const TopBar = ({ onSettings, onHelp }: { onSettings: () => void; onHelp: () => void }) => {
  const { bundle } = useReport();
  const { repo, branch } = bundle.diff;
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <OwnerMenu />
          {repo.owner && <span className="text-zinc-400">/</span>}
          <span className="truncate font-semibold">{repo.name}</span>
        </div>
        <span className="hidden items-center gap-1.5 rounded-md bg-zinc-500/10 px-2 py-1 font-mono text-xs text-zinc-600 md:inline-flex dark:text-zinc-300">
          <GitBranch className="size-3.5" />
          {branch.head}
          <span className="text-zinc-400">→</span>
          {branch.base}
        </span>
        {window.__PR_REVIEW__ && (
          <a href="/" className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
            <Inbox className="size-3.5" /> All reviews
          </a>
        )}
        {window.__PR_REVIEW__ ? (
          <UserMenu onSettings={onSettings} onHelp={onHelp} />
        ) : (
          // The standalone HTML file has no daemon to ask who is reading it, so it keeps the plain settings button.
          <button
            type="button"
            onClick={onSettings}
            title="Settings and keyboard shortcuts (?)"
            className="ml-auto inline-flex rounded-md p-2 text-zinc-500 hover:bg-zinc-500/10 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <Settings className="size-4" />
          </button>
        )}
      </div>
    </header>
  );
};

export const Hero = () => {
  const { bundle, viewedCount } = useReport();
  const { diff, report } = bundle;
  const { branch, scope, stats, commits, coverage } = diff;
  const pr = usePr();

  const failedChecks = useChecks()?.results.filter((r) => r.status !== "passed").length ?? 0;
  const levelCounts = report.sections.reduce(
    (acc, s) => ({ ...acc, [s.review]: acc[s.review] + s.files.length }),
    { must: 0, skim: 0, skip: 0 },
  );

  const scopeText =
    scope.mode === "branch"
      ? `${commits.length} commits since the merge base with ${branch.base}`
      : scope.mode.startsWith("since")
        ? `Changes since ${scope.from.slice(0, 7)} (your last report)`
        : `Only files changed in this session`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5" />
          <span className="font-mono">{branch.head}</span> into <span className="font-mono">{branch.base}</span>
          <span className="text-zinc-400">({BASE_SOURCE[branch.baseSource]})</span>
        </span>
        <details className="group relative">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 hover:text-zinc-800 dark:hover:text-zinc-200">
            <GitCommitHorizontal className="size-3.5" />
            {scopeText}
            {stats.uncommittedFiles > 0 && (
              <span className="text-amber-600 dark:text-amber-400"> + {stats.uncommittedFiles} uncommitted files</span>
            )}
          </summary>
          <ol className="surface absolute left-0 z-20 mt-2 w-[min(520px,90vw)] space-y-1 rounded-lg border p-3 shadow-xl">
            {commits.map((c) => (
              <li key={c.sha} className="flex gap-3 text-xs">
                <span className="font-mono text-zinc-400">{c.short}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{c.subject}</span>
                <span className="shrink-0 text-zinc-400">{new Date(c.date).toLocaleDateString()}</span>
              </li>
            ))}
          </ol>
        </details>
        {pr && (
          <a href={pr.url} target="_blank" rel="noreferrer" title={pr.title ?? undefined} className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline">
            PR #{pr.number}
            <PrStatePill state={pr.state} className="py-0 text-[11px]" />
          </a>
        )}
      </div>

      <div className="space-y-3">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-balance">
          {!bundle.draft && (
            <TagPill tag={report.tag} className="mr-2.5 translate-y-[-3px] align-middle" />
          )}
          {report.title}
        </h1>
        {bundle.draft ? (
          <p className="inline-flex max-w-3xl items-center gap-2 text-[15px] leading-relaxed text-violet-700 dark:text-violet-300">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            Claude is reading the change and writing the notes. The diffs and checks are already here, and this page fills in by itself.
          </p>
        ) : (
          <p className="max-w-3xl text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">{report.summary}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {report.targets.map((t) => (
          <Pill key={t} className={TARGETS[t].className}>
            <Dot className={TARGETS[t].dot} />
            {TARGETS[t].label}
          </Pill>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--border)] pt-4 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <FileCode2 className="size-4 text-zinc-400" />
          {stats.files} files
          <LocCount additions={stats.additions} deletions={stats.deletions} className="ml-1" />
        </span>
        {!bundle.draft && (
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-4 text-zinc-400" />
            About {report.reviewMinutes} min to review
          </span>
        )}
        {!bundle.draft && (
          <span className="inline-flex items-center gap-3 text-xs">
            {(["must", "skim", "skip"] as const).map((level) => (
              <span key={level} className="inline-flex items-center gap-1.5">
                <Dot className={REVIEW[level].dot} />
                {levelCounts[level]} {REVIEW[level].label.toLowerCase()}
              </span>
            ))}
          </span>
        )}
        {failedChecks > 0 && (
          <a href="#project-checks" className="inline-flex items-center gap-1.5 font-medium text-red-600 hover:underline dark:text-red-400">
            <CircleX className="size-4" />
            {failedChecks} {failedChecks === 1 ? "check" : "checks"} failed
          </a>
        )}
        {coverage?.percent != null && (
          <a href="#coverage" className="inline-flex items-center gap-1.5 hover:underline">
            <FlaskConical className="size-4 text-zinc-400" />
            Tests run {coverage.percent}% of new lines
            {coverage.sources.some((s) => s.stale) && <span className="text-xs text-amber-600 dark:text-amber-400">(coverage file is older than the changes)</span>}
          </a>
        )}
        <span className="ml-auto inline-flex items-center gap-3 text-xs text-zinc-500">
          <PrDescription />
          <span>
            {viewedCount}/{stats.files} viewed
          </span>
        </span>
      </div>
    </div>
  );
};
