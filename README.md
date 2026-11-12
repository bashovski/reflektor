# pr-report

A skill for coding agents that turns a branch into a review report in your browser. It is built and tested with Claude Code, and installs for Codex and other agents that read the open [Agent Skills](https://agentskills.io) format. The report has:

- a plain-English title and summary
- the files to review, in order of risk
- highlights for each area
- the request flow from UI to database
- the types, interfaces, enums and constants it adds, changes or removes
- GitHub-style diffs with notes
- test coverage of the new lines

It works with any language or stack. It only needs git and Node.js 18 or newer.

## Install

```bash
./install.sh
```

It runs two steps, which also work on their own:

- **`pnpm build`** makes the skill's package in `dist/skill/`: the scripts compiled from TypeScript to JavaScript for Node 18, the viewer, and the files the agent reads. `dist/` is never committed.
- **`pnpm run deploy`** links `~/.claude/skills/pr-report` to `dist/skill/`, so each new `pnpm build` applies right away. With `--copy` it copies the folder instead. It refuses a package older than the source. It has to be `pnpm run deploy`: plain `pnpm deploy` is a pnpm command of its own.

Building needs the Node that Vite 8 needs for the viewer: 20.19, or 22.12 and newer. The tools in `scripts/` are TypeScript too, and `pnpm run tools` compiles them into `dist/tools/` before any of them runs, so they behave the same on every such Node. The skill it builds runs on Node 18.

For Codex and other agents that read `~/.agents/skills`, run `./install.sh --target agents`. That installs a copy with its own `SKILL.md`, in which the skill's folder is written out and Claude Code's own front matter is left out, so deploy again after each build. `--target <folder>` installs into any other skills folder, and `--target` can be given more than once (`--target claude --target agents`).

A first install ends in the browser, on a one-minute setup page: whether the GitHub and GitLab command lines (`gh`, `glab`) are installed and logged in, with the commands to get there, then light or dark, then a code theme with a live preview. Enter moves on and Escape skips. `--no-open` leaves the browser alone; `node ~/.claude/skills/pr-report/scripts/review.mjs setup` opens the page any time, and so does a link in a report's settings. The choices live in that browser, next to the diff style, and the report's gear (or `?`) changes them later. An inbox or report opened in a browser that never ran the setup offers it once.

On Windows, run `pnpm build`, then `pnpm run deploy` (or `--copy`), in PowerShell, cmd or Git Bash. The link is a directory junction, so it needs no admin rights. Claude Code on Windows runs commands in Git Bash, and so do the project checks.

Then, in any git repo, ask your agent for a PR report. In Claude Code you can also type:

```
/pr-report              compare with the PR base or the default branch
/pr-report develop      compare with develop
/pr-report --since last only what changed since the last report
/pr-report --session    only files changed in this session
/pr-report resume       pick up a review in a new session
```

In Codex, type `$pr-report` and say the rest in words, such as "compare with develop".

The report data is written to `<git folder>/pr-report/<branch>/` (usually `.git/pr-report/<branch>/`), one JSON file per round, and opens in your browser through the review daemon. Nothing is added to the repo's tracked files or branches. Hidden refs keep the code each report showed (uncommitted work included): `refs/pr-report/last` for `--since last`, and `refs/pr-report/rounds/<branch>/r<N>` so a later round can show what changed since an earlier one.

## How it works

1. **`collect.mjs`** reads git and writes `diff.json`: changed files, full old and new contents, commits, and coverage of new lines. The page opens right away with these facts (`build.mjs --draft`), so you can read the diffs and watch the checks while the agent writes.
2. **The agent** reads the changes and writes `report.json`: title, summary, sections, highlights, notes and flows. It points at lines and never copies code.
3. **`build.mjs`** checks `report.json` against the git facts, drops anything that points at code that doesn't exist, and writes both into one JSON file per round. With `--html <file>` it also writes a self-contained HTML page to keep or send. It writes `pr-description.md` only from reports of the whole branch.
4. **`review.mjs open`** publishes the report to the **pr-report daemon**, one local server for every review on this machine: `http://127.0.0.1:7337`, with an inbox of all reviews at `/`. It starts the daemon when needed, and the daemon stops after 4 idle hours. In the report you can:
   - comment on lines (hover a line number and click +), files or the whole change
   - use "Fix this" or "It's fine" on problems, and answer the agent's questions
   - ask the agent live with the "Ask ... now" button
   - send the review with the button at the bottom, or Ctrl+Enter (Cmd+Enter on a Mac)

   The agent's plan then shows up in the page to approve, each comment shows the agent's progress live, and the next round arrives as a banner in the same tab. Every round shows the whole branch, with a switch to see only what changed since the round you sent; `collect.mjs --update` carries the last report forward and moves its line references to where those lines are now. Each repo's `.git/pr-report/` folder stays the source of truth; the daemon only keeps a list of them in `~/.pr-report/`.

   A review outlives the session that made it. When you send something and no session is listening, the page says so and tells you what to type in a new one (`/pr-report resume` in Claude Code). When the code changes after a report was built, the page lists the files and can ask the agent to update the report.

   The page follows the branch's pull request on GitHub. The agent tells the daemon when it opens one (`review.mjs pr`); for a pull request opened, merged or closed by hand, the daemon asks GitHub about once a minute while the page is open, through `gh`'s token and with conditional requests, so an unchanged answer is a `304 Not Modified` that does not count against GitHub's rate limit. The header shows the state, a merged pull request gets a banner and marks the before-merge items done, and the inbox shows the review as merged. `PR_REPORT_PR_POLL_SECONDS` sets the interval; without `gh` the page shows the state as of the last report.

   The inbox groups reviews by repo owner, with the owner's avatar above each group. Its toolbar groups by repo, status or type instead, sorts by activity, waiting on you or title, and filters by status and type, with a fuzzy search over titles, repos and branches (press `/`); the browser remembers the choice. It archives finished reviews after 3 quiet days and others after 14. You can archive and restore by hand, and delete an archived review's files.

   The daemon serves the viewer as normal files the browser caches (about 1.3 MB on first visit). Each report is only its JSON data. Diffs render the lines near the screen only, and code is colored with WebAssembly lexers, so a 40-file change opens in well under a second.

   The project's own lint, typecheck and test commands run in the background while the agent reads the change, and their results stream into the open report. The agent works out the commands once per repo (from the CI config first) and saves them in `~/.pr-report/repos/<host>/<owner>/<repo>/checks.json`, so later reports reuse them. They are worked out again when the files they came from change or a command stops working. `checks.mjs --share` copies them into `.pr-report.json` for the team; `--forget` deletes them. When the branch has commits by someone else, such as a teammate's PR, Claude asks before running them, since they run that code.

   The header and the inbox show the repo owner's avatar. For github.com and gitlab.com it is downloaded once into `~/.pr-report/cache/avatars/` and never again; delete that folder to refresh. Other hosts, and owners without a picture, get their initials on a color.

   The page names the agent it talks to: "Send to Claude", "Send to Codex". `review.mjs` works that out from the shell it runs in (a flag, then `AI_AGENT`, then a marker only one agent sets, then the skills folder it was started from, then the agent's own answer) and tells the daemon with every call, so the page follows when another agent picks a review up. `skill/agents.json` holds the names. An agent with no entry gets a name made from its id, and with nothing known the page says "your agent".

## Layout

| Path | What it is |
|---|---|
| `skill/` | The source of what the agent loads. Only source lives here; `pnpm build` turns it into `dist/skill/`. |
| `skill/SKILL.md` | The steps the agent follows |
| `skill/subagents.md` | The extra steps for Subagentic Mode, read only when it is on |
| `skill/agents.json` | The agents pr-report knows by name, and how to recognize them |
| `skill/style-guide.md` | How report text is written |
| `skill/schema/types.ts` | The data contract, and the only list of allowed values |
| `skill/scripts/` | `collect.mts`, `checks.mts`, `build.mts`, `review.mts` (agent CLI), `agent.mts` (which agent is calling) and `daemon.mts` (review server), in TypeScript with no dependencies. `tsconfig.skill.json` compiles them to `.mjs` for Node 18. |
| `dist/skill/` | The package `pnpm build` makes, and the folder that gets linked, or copied for agents other than Claude Code. Gitignored. |
| `viewer/` | React source of the report page, and the inbox's scripts in `viewer/src/inbox/`, which the daemon puts into the inbox page |
| `fixtures/make-books-repo.sh` | Builds a fake repo with a "books" feature branch |
| `samples/report.json` | A hand-written report for that fake repo |
| `scripts/` | The repo's tools, in TypeScript. `tsconfig.tools.json` compiles them into `dist/tools/`, and they only run from there. |
| `scripts/check.mts` | End-to-end test on the fake repo |
| `scripts/browser-check.mts` | The same review clicked through the real page in headless Chrome |
| `scripts/build-skill.mts` | `pnpm build`: makes `dist/skill/` |
| `scripts/deploy.mts` | `pnpm run deploy`: installs `dist/skill/` for one or more agents |
| `scripts/build-icons.mts` | Builds `dist/skill/assets/file-icons.json` from the icon package |
| `scripts/portable-skill.mts` | Writes `SKILL.md` for agents other than Claude Code |

## Changing it

| You want to change | Edit | Then |
|---|---|---|
| How the agent writes or what it flags | `skill/SKILL.md`, `skill/subagents.md`, `skill/style-guide.md` | `pnpm build`; with a linked install the next run uses it. For a copy, `pnpm run deploy` again. |
| How the report looks | `viewer/src/` | `pnpm dev` to see it live, `pnpm build` to ship it |
| Allowed values (tags, section kinds, ...) | `skill/schema/types.ts` | Add a label and color in `viewer/src/lib/meta.ts`; TypeScript points at the spot |
| What is read from git | `skill/scripts/collect.mts` | `pnpm check` (it builds first) |

Commands:

```bash
pnpm check    # build (which typechecks the skill and the tools), then run the whole pipeline on the fake repo; fails on any warning
pnpm check:browser  # drive a whole review through the page in headless Chrome (needs Google Chrome)
pnpm dev      # viewer with live reload, using the sample data (run pnpm check once first)
pnpm build    # make the package in dist/skill/: scripts compiled for Node 18, the viewer, the agent's files
pnpm run deploy  # install dist/skill/ for Claude Code (--copy, --target agents, --target <folder>)
pnpm sample   # check, then open the sample report
pnpm run notices  # rewrite skill/THIRD-PARTY-NOTICES.md after the viewer's packages change
```

To redo an old report with a new viewer, without asking the agent again:

```bash
node ~/.claude/skills/pr-report/scripts/build.mjs --diff .git/pr-report/<branch>/diff.json --report .git/pr-report/<branch>/report.json --open
```

## Subagentic Mode

Off by default. Turned on in the setup wizard or in Settings, it tells the agent to split a bigger change between subagents, one for each section of the report, which read and write at the same time. That is faster and costs more tokens. It needs an agent that can start subagents, like Claude Code, and small changes are written the usual way. The setting is kept in `~/.pr-report/settings.json`, where the skill's scripts read it.

## Per-repo settings

An optional `.pr-report.json` in a repo's root sets the base branch, which paths belong to which target, extra generated files, where coverage files are, the project checks and the hooks. See the end of `skill/SKILL.md` for an example.

### Hooks

Hooks are a team's own commands, run at fixed points of a report. They live in `.pr-report.json`, so everyone who clones the repo gets them, and the scripts run them, so they run every time and with any agent.

| Hook | Run by | When | A failure |
|---|---|---|---|
| `preRun` | `collect.mjs` | Before it fetches and reads the changes | Stops the report |
| `postRun` | `review.mjs open` | Once a round, when its report (not the draft) is first published | Prints a warning |
| `onApproved` | `review.mjs wait` or `resume` | The reviewer finishes with nothing left to fix | Prints a warning |

```json
{
  "hooks": {
    "preRun": ["pnpm codegen", "bash tools/ticket.sh"],
    "onApproved": "bash tools/open-pr.sh"
  }
}
```

A hook is one command or a list, run one after another in the repo's root: in sh on macOS and Linux, in Git Bash on Windows, as the project checks are. A failing command ends its list. `preRun` may take 5 minutes and the others 2; a hook that runs longer is stopped and counts as failed. What a hook prints goes to the agent, which is how `preRun` can hand over a ticket's text.

Each hook gets these variables:

| Variable | Holds | Set for |
|---|---|---|
| `PR_REPORT_HOOK` | The hook's name | All |
| `PR_REPORT_BRANCH`, `PR_REPORT_BASE` | The branch and its base | All |
| `PR_REPORT_ROUND` | The round number | `postRun`, `onApproved` |
| `PR_REPORT_DIFF` | Path of `diff.json`: the git facts, with full file contents | `postRun`, `onApproved` |
| `PR_REPORT_REPORT` | Path of `report.json`: what the agent wrote | `postRun`, `onApproved` |
| `PR_REPORT_URL` | The review page | `postRun`, `onApproved` |
| `PR_REPORT_PR_TEXT` | Path of `pr-description.md` (title line, blank line, body), when there is one | `postRun`, `onApproved` |

The two files' shapes are `DiffData` and `Report` in `skill/schema/types.ts`. They can change between versions; the variables are the stable part.

Two examples. `tools/ticket.sh` prints the GitHub issue named in the branch (`feat/123-save-books`), so the agent knows why the change was made:

```bash
n=$(grep -oE '[0-9]+' <<<"$PR_REPORT_BRANCH" | head -1)
[ -n "$n" ] && gh issue view "$n" --json title,body --jq '.title + "\n\n" + .body'
exit 0
```

`tools/open-pr.sh` pushes the branch and opens the pull request with the text the build wrote, once the reviewer approves:

```bash
set -e
[ -n "$PR_REPORT_PR_TEXT" ] || { echo "No PR description yet: build a whole-branch report first."; exit 0; }
git push -u origin "$PR_REPORT_BRANCH"
gh pr create --base "$PR_REPORT_BASE" --title "$(head -1 "$PR_REPORT_PR_TEXT")" --body "$(tail -n +3 "$PR_REPORT_PR_TEXT")"
```

Things to know:

- **No sandbox.** A hook runs as you and can do whatever you can in a terminal.
- **The checks' trust rule.** A teammate's branch can change `.pr-report.json`, so hooks do not run while the branch has commits by someone you have not trusted for this repo, and they do not run when the base branch cannot be found. `checks.mjs --trust` records the trust; `--forget` removes it.
- **Code leaves with `diff.json`.** It holds full file contents, so a hook that uploads it uploads the code.
- **`onApproved` needs a listener.** It runs in the agent's waiter, or in `/pr-report resume` when no waiter was running. The daemon and the page never run a command.

## Credits

File type icons come from [atom-material-icons](https://www.npmjs.com/package/atom-material-icons) by Elior Boukhobza "Mallowigi", MIT License. Product logos in the icons belong to their owners. The inbox search uses [Fuse.js](https://www.fusejs.io) by Kiro Risk, Apache License 2.0. The license text of everything bundled is in [skill/THIRD-PARTY-NOTICES.md](skill/THIRD-PARTY-NOTICES.md), written by `scripts/build-notices.mts` from the installed packages.

## Known issues

- **Symlinked skill folders in Claude Code:** `/skills` may not list them, and an update may remove the link. Both come from user reports on GitHub. If the skill goes missing, run `pnpm run deploy` again, or with `--copy`.
- **Exported pages are large:** a page from `build.mjs --html` is about 11 MB, because it carries every Shiki language grammar as a fallback for browsers without WebAssembly. Reports opened through the daemon load the viewer once and are only their data.
