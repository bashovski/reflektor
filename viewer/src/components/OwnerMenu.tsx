import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown, ExternalLink, GitPullRequestCreateArrow, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import type { DiffData, Forge } from "../../../skill/schema/types";
import { PR_STATES } from "../lib/meta";
import { usePr } from "../lib/pr";
import { useReport } from "../lib/state";
import { cx, OwnerAvatar } from "./ui";

const FORGES: Record<Forge, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// A branch name in a URL path: each part escaped, the slashes kept.
const pathOf = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

// The forge's form for a new pull request from this branch, filled in with the report's PR description.
// Forges refuse very long URLs, so past about 8 KB the form gets the title only.
function newPullRequestUrl(web: NonNullable<DiffData["repo"]["web"]>, base: string, head: string, title: string, body: string | null) {
  const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
  const build = (text: string | null) => {
    if (web.forge === "github") return `${web.url}/compare/${pathOf(base)}...${pathOf(head)}?${query({ expand: "1", title, ...(text ? { body: text } : {}) })}`;
    if (web.forge === "gitlab")
      return `${web.url}/-/merge_requests/new?${query({
        "merge_request[source_branch]": head,
        "merge_request[target_branch]": base,
        "merge_request[title]": title,
        ...(text ? { "merge_request[description]": text } : {}),
      })}`;
    if (web.forge === "bitbucket") return `${web.url}/pull-requests/new?${query({ source: head, dest: base })}`;
    return null;
  };
  const full = build(body);
  return full && full.length > 8000 ? build(null) : full;
}

type Item = { key: string; href: string; external: boolean; icon: ReactNode; label: ReactNode; detail: string; warning?: string };

// The owner's avatar and name in the top bar. Clicking them opens links to the owner's page, the
// inbox and the branch's pull request, each only when it applies.
export const OwnerMenu = () => {
  const { bundle } = useReport();
  const { repo, branch } = bundle.diff;
  const web = repo.web ?? null;
  // Live: a pull request opened or merged after the report was built counts.
  const pr = usePr();
  const items: Item[] = [];

  if (web)
    items.push({
      key: "owner",
      href: web.ownerUrl,
      external: true,
      icon: <OwnerAvatar avatar={repo.avatar} className="size-4 text-[7px]" />,
      label: "Open Owner Page",
      detail: `${repo.owner} on ${web.forge ? FORGES[web.forge] : repo.host}`,
    });
  // The inbox, showing only this owner's reviews when there is an owner.
  if (window.__PR_REVIEW__)
    items.push({
      key: "inbox",
      href: repo.owner ? `/?owner=${encodeURIComponent(repo.owner)}` : "/",
      external: false,
      icon: <Inbox />,
      label: repo.owner ? (
        <>
          View All Reports for <span className="text-zinc-500 dark:text-zinc-400">{repo.owner}</span>
        </>
      ) : (
        "View All Reports"
      ),
      detail: "In the inbox on this machine",
    });

  // A new pull request makes sense when the branch has none, or only a closed one.
  const onBranch = branch.head !== "HEAD" && branch.head !== branch.base;
  const newPr = web?.forge && onBranch && (!pr || pr.state === "CLOSED") ? newPullRequestUrl(web, branch.base, branch.head, bundle.prDescription?.title ?? `[${bundle.report.tag}] ${bundle.report.title}`, bundle.prDescription?.body ?? null) : null;
  if (newPr) {
    const unpushed = branch.upstream === null ? `${branch.head} is not pushed yet` : branch.upstream?.ahead ? `${plural(branch.upstream.ahead, "commit")} not pushed yet` : undefined;
    items.push({
      key: "new-pr",
      href: newPr,
      external: true,
      icon: <GitPullRequestCreateArrow />,
      label: "Open Pull Request",
      detail: `${branch.head} into ${branch.base}${bundle.prDescription ? ", filled in from this report" : ""}`,
      warning: unpushed,
    });
  }
  if (pr) {
    const state = PR_STATES[pr.state];
    const Icon = state.icon;
    items.push({
      key: "pr",
      href: pr.url,
      external: true,
      icon: <Icon className={state.className} />,
      label: "View Pull Request",
      detail: `#${pr.number}, ${state.label.toLowerCase()}${pr.title ? `: ${pr.title}` : ""}`,
    });
  }

  const owner = (
    <>
      <OwnerAvatar avatar={repo.avatar} className="size-6 text-[11px]" />
      {repo.owner && <span className="truncate text-zinc-500">{repo.owner}</span>}
    </>
  );
  if (!items.length) return <span className="flex min-w-0 items-center gap-2">{owner}</span>;

  return (
    <Menu>
      <MenuButton
        title="Owner, all reports and pull request"
        className="-ml-1 flex min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-1 hover:bg-zinc-500/10 focus:outline-none data-[focus]:ring-2 data-[focus]:ring-zinc-400/60 data-[open]:bg-zinc-500/10"
      >
        {owner}
        <ChevronDown className="size-3.5 shrink-0 text-zinc-400" />
      </MenuButton>
      <MenuItems
        anchor="bottom start"
        transition
        className="surface z-50 w-80 origin-top-left rounded-xl border p-1.5 text-sm shadow-lg shadow-black/10 transition duration-100 ease-out [--anchor-gap:6px] focus:outline-none data-[closed]:scale-95 data-[closed]:opacity-0"
      >
        {items.map((item) => (
          <MenuItem key={item.key}>
            <a
              href={item.href}
              {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
              className="group flex items-start gap-3 rounded-lg px-2.5 py-2 data-[focus]:bg-zinc-500/10"
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-zinc-500 [&>svg]:size-4">{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{item.label}</span>
                <span className="line-clamp-2 block text-xs break-words text-zinc-500">{item.detail}</span>
                {item.warning && <span className="mt-0.5 block text-xs text-amber-600 dark:text-amber-400">{item.warning}</span>}
              </span>
              {item.external && <ExternalLink className={cx("mt-0.5 size-3.5 shrink-0 text-zinc-400 opacity-0 group-data-[focus]:opacity-100")} />}
            </a>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
};
