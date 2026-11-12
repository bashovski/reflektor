# pr-report

A skill for coding agents that turns a branch into a review report in your browser. It is built and tested with Claude Code, and installs for Codex and other agents that read the open [Agent Skills](https://agentskills.io) format. The report has:

- a plain-English title and summary
- the files to review, in order of risk
- highlights for each area
- the request flow from UI to database
- the types, interfaces, enums and constants it adds, changes or removes
- GitHub-style diffs with notes
- test coverage of the new lines

It works with any language or stack. It only needs git and Node.js.

## Install

```bash
./install.sh
```

The script builds the viewer and links `~/.claude/skills/pr-report` to this repo's `skill/` folder, so edits apply right away. Use `./install.sh --copy` to copy the folder instead.

For Codex and other agents that read `~/.agents/skills`, run `./install.sh --target agents`. That installs a copy with its own `SKILL.md`, in which the skill's folder is written out and Claude Code's own front matter is left out, so run it again after updating pr-report. `--target <folder>` installs into any other skills folder, and `--target` can be given more than once (`--target claude --target agents`).

A first install ends in the browser, on a one-minute setup page: whether the GitHub and GitLab command lines (`gh`, `glab`) are installed and logged in, with the commands to get there, then light or dark, then a code theme with a live preview. Enter moves on and Escape skips. `--no-open` leaves the browser alone; `node skill/scripts/review.mjs setup` opens the page any time, and so does a link in a report's settings. The choices live in that browser, next to the diff style, and the report's gear (or `?`) changes them later. An inbox or report opened in a browser that never ran the setup offers it once.

On Windows, run `node scripts/install.mjs` (or `--copy`) in PowerShell, cmd or Git Bash. The link is a directory junction, so it needs no admin rights. Claude Code on Windows runs commands in Git Bash, and so do the project checks.

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

1. **`skill/scripts/collect.mjs`** reads git and writes `diff.json`: changed files, full old and new contents, commits, and coverage of new lines. The page opens right away with these facts (`build.mjs --draft`), so you can read the diffs and watch the checks while the agent writes.
2. **The agent** reads the changes and writes `report.json`: title, summary, sections, highlights, notes and flows. It points at lines and never copies code.
3. **`skill/scripts/build.mjs`** checks `report.json` against the git facts, drops anything that points at code that doesn't exist, and writes both into one JSON file per round. With `--html <file>` it also writes a self-contained HTML page to keep or send. It writes `pr-description.md` only from reports of the whole branch.
4. **`skill/scripts/review.mjs open`** publishes the report to the **pr-report daemon**, one local server for every review on this machine: `http://127.0.0.1:7337`, with an inbox of all reviews at `/`. It starts the daemon when needed, and the daemon stops after 4 idle hours. In the report you can:
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
| `skill/` | What the agent loads. This is the folder that gets linked, or copied for agents other than Claude Code. |
| `skill/SKILL.md` | The steps the agent follows |
| `skill/subagents.md` | The extra steps for Subagentic Mode, read only when it is on |
| `skill/agents.json` | The agents pr-report knows by name, and how to recognize them |
| `skill/style-guide.md` | How report text is written |
| `skill/schema/types.ts` | The data contract, and the only list of allowed values |
| `skill/scripts/` | `collect.mjs`, `checks.mjs`, `build.mjs`, `review.mjs` (agent CLI), `agent.mjs` (which agent is calling) and `daemon.mjs` (review server). No dependencies. |
| `viewer/` | React source of the report page |
| `fixtures/make-books-repo.sh` | Builds a fake repo with a "books" feature branch |
| `samples/report.json` | A hand-written report for that fake repo |
| `scripts/check.mjs` | End-to-end test on the fake repo |
| `scripts/browser-check.mjs` | The same review clicked through the real page in headless Chrome |
| `scripts/build-icons.mjs` | Builds `skill/assets/file-icons.json` from the icon package |
| `scripts/install.mjs` | Builds the viewer and installs the skill for one or more agents |
| `scripts/portable-skill.mjs` | Writes `SKILL.md` for agents other than Claude Code |

## Changing it

| You want to change | Edit | Then |
|---|---|---|
| How the agent writes or what it flags | `skill/SKILL.md`, `skill/subagents.md`, `skill/style-guide.md` | Nothing with a linked install: the next run uses it. For a copy, run the installer again. |
| How the report looks | `viewer/src/` | `pnpm dev` to see it live, `pnpm build` to ship it |
| Allowed values (tags, section kinds, ...) | `skill/schema/types.ts` | Add a label and color in `viewer/src/lib/meta.ts`; TypeScript points at the spot |
| What is read from git | `skill/scripts/collect.mjs` | `pnpm check` |

Commands:

```bash
pnpm check    # typecheck, then run the whole pipeline on the fake repo; fails on any warning
pnpm check:browser  # drive a whole review through the page in headless Chrome (needs Google Chrome)
pnpm dev      # viewer with live reload, using the sample data (run pnpm check once first)
pnpm build    # build the viewer: skill/assets/app/ (served by the daemon) and skill/assets/viewer.html (standalone)
pnpm sample   # check, then open the sample report
```

To redo an old report with a new viewer, without asking the agent again:

```bash
node skill/scripts/build.mjs --diff .git/pr-report/<branch>/diff.json --report .git/pr-report/<branch>/report.json --open
```

## Subagentic Mode

Off by default. Turned on in the setup wizard or in Settings, it tells the agent to split a bigger change between subagents, one for each section of the report, which read and write at the same time. That is faster and costs more tokens. It needs an agent that can start subagents, like Claude Code, and small changes are written the usual way. The setting is kept in `~/.pr-report/settings.json`, where the skill's scripts read it.

## Per-repo settings

An optional `.pr-report.json` in a repo's root sets the base branch, which paths belong to which target, extra generated files, and where coverage files are. See the end of `skill/SKILL.md` for an example.

## Credits

File type icons come from [atom-material-icons](https://www.npmjs.com/package/atom-material-icons) by Elior Boukhobza "Mallowigi", MIT License. Product logos in the icons belong to their owners. The inbox search uses [Fuse.js](https://www.fusejs.io) by Kiro Risk, Apache License 2.0. The license text of everything bundled is in [skill/THIRD-PARTY-NOTICES.md](skill/THIRD-PARTY-NOTICES.md), written by `scripts/build-notices.mjs` from the installed packages.

## Known issues

- **Symlinked skill folders in Claude Code:** `/skills` may not list them, and an update may remove the link. Both come from user reports on GitHub. If the skill goes missing, run `./install.sh` again, or use `--copy`.
- **Exported pages are large:** a page from `build.mjs --html` is about 11 MB, because it carries every Shiki language grammar as a fallback for browsers without WebAssembly. Reports opened through the daemon load the viewer once and are only their data.
