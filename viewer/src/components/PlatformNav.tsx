import { PROJECT } from "../lib/meta";
import { PLATFORM_PAGES, useAppUrl } from "../lib/reflektor";
import { GitHubMark } from "./ui";

// Reflektor's pages next to the logo, laid out like the platform's top bar: a divider, then Docs, Examples, Pricing
// and GitHub. Each opens in a new tab. Only on pages that are not a report (Settings); a report has its own bar.
// The inbox, written by the daemon, draws the same row (see inboxPage in skill/scripts/daemon.mts).
export const PlatformNav = () => {
  const app = useAppUrl();
  const link = "inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-sm font-medium text-muted hover:bg-zinc-500/10 hover:text-[var(--text)]";
  return (
    <>
      <span aria-hidden className="hidden h-5 w-px shrink-0 bg-[var(--border)] min-[560px]:block" />
      <nav aria-label="Reflektor" className="hidden min-w-0 items-center gap-0.5 min-[560px]:flex">
        {PLATFORM_PAGES.map((page) => (
          <a key={page.path} href={`${app}${page.path}`} target="_blank" rel="noreferrer" className={link}>
            {page.label}
          </a>
        ))}
        <a href={PROJECT.repo} target="_blank" rel="noreferrer" className={link}>
          <GitHubMark className="size-[15px]" />
          GitHub
        </a>
      </nav>
    </>
  );
};
