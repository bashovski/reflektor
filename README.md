# pr-report

A Claude Code skill that turns a branch into a review report in your browser. The report has:

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

Then, in any git repo, ask Claude for a PR report or type:

```
/pr-report              compare with the PR base or the default branch
/pr-report develop      compare with develop
/pr-report --since last only what changed since the last report
/pr-report --session    only files changed in this Claude session
```

The report data is written to `<git folder>/pr-report/<branch>-<sha>-r<round>.json` (usually `.git/pr-report/`) and opens in your browser through the review daemon. Nothing is added to the repo's tracked files or branches. One hidden ref, `refs/pr-report/last`, records what the last report showed (uncommitted work included), so `--since last` shows only what is new.

## How it works

1. **`skill/scripts/collect.mjs`** reads git and writes `diff.json`: changed files, full old and new contents, commits, and coverage of new lines.
2. **Claude** reads the changes and writes `report.json`: title, summary, sections, highlights, notes and flows. It points at lines and never copies code.
3. **`skill/scripts/build.mjs`** checks `report.json` against the git facts, drops anything that points at code that doesn't exist, and writes both into one JSON file per round. With `--html <file>` it also writes a self-contained HTML page to keep or send.
4. **`skill/scripts/review.mjs open`** publishes the report to the **pr-report daemon**, one local server for every review on this machine: `http://127.0.0.1:7337`, with an inbox of all reviews at `/`. It starts the daemon when needed, and the daemon stops after 4 idle hours. In the report you can:
   - comment on lines (hover a line number and click +), files or the whole change
   - use "Fix this" or "It's fine" on problems, and answer Claude's questions
   - ask Claude live with "Ask Claude now"
   - click "Send to Claude"

   Claude's plan then shows up in the page to approve, each comment shows Claude's progress live, and the next round arrives as a banner in the same tab. Each repo's `.git/pr-report/` folder stays the source of truth; the daemon only keeps a list of them in `~/.pr-report/`.

   The daemon serves the viewer as normal files the browser caches (about 1.3 MB on first visit). Each report is only its JSON data. Diffs render the lines near the screen only, and code is colored with WebAssembly lexers, so a 40-file change opens in well under a second.

   The project's own lint, typecheck and test commands run in the background while Claude reads the change, and their results stream into the open report. Claude works out the commands once per repo (from the CI config first) and saves them in `~/.pr-report/repos/<host>/<owner>/<repo>/checks.json`, so later reports reuse them. They are worked out again when the files they came from change or a command stops working. `checks.mjs --share` copies them into `.pr-report.json` for the team; `--forget` deletes them.

   The header and the inbox show the repo owner's avatar. For github.com and gitlab.com it is downloaded once into `~/.pr-report/cache/avatars/` and never again; delete that folder to refresh. Other hosts, and owners without a picture, get their initials on a color.

## Layout

| Path | What it is |
|---|---|
| `skill/` | What Claude loads. This is the folder that gets linked. |
| `skill/SKILL.md` | The steps Claude follows |
| `skill/style-guide.md` | How report text is written |
| `skill/schema/types.ts` | The data contract, and the only list of allowed values |
| `skill/scripts/` | `collect.mjs`, `checks.mjs`, `build.mjs`, `review.mjs` (agent CLI) and `daemon.mjs` (review server). No dependencies. |
| `viewer/` | React source of the report page |
| `fixtures/make-books-repo.sh` | Builds a fake repo with a "books" feature branch |
| `samples/report.json` | A hand-written report for that fake repo |
| `scripts/check.mjs` | End-to-end test on the fake repo |
| `scripts/build-icons.mjs` | Builds `skill/assets/file-icons.json` from the icon package |

## Changing it

| You want to change | Edit | Then |
|---|---|---|
| How Claude writes or what it flags | `skill/SKILL.md`, `skill/style-guide.md` | Nothing. The next run uses it. |
| How the report looks | `viewer/src/` | `pnpm dev` to see it live, `pnpm build` to ship it |
| Allowed values (tags, section kinds, ...) | `skill/schema/types.ts` | Add a label and color in `viewer/src/lib/meta.ts`; TypeScript points at the spot |
| What is read from git | `skill/scripts/collect.mjs` | `pnpm check` |

Commands:

```bash
pnpm check    # typecheck, then run the whole pipeline on the fake repo; fails on any warning
pnpm dev      # viewer with live reload, using the sample data (run pnpm check once first)
pnpm build    # build the viewer: skill/assets/app/ (served by the daemon) and skill/assets/viewer.html (standalone)
pnpm sample   # check, then open the sample report
```

To redo an old report with a new viewer, without asking Claude again:

```bash
node skill/scripts/build.mjs --diff .git/pr-report/diff.json --report .git/pr-report/report.json --open
```

## Per-repo settings

An optional `.pr-report.json` in a repo's root sets the base branch, which paths belong to which target, extra generated files, and where coverage files are. See the end of `skill/SKILL.md` for an example.

## Credits

File type icons come from [atom-material-icons](https://www.npmjs.com/package/atom-material-icons) by Elior Boukhobza "Mallowigi", MIT License. Product logos in the icons belong to their owners.

## Known issues

- **Symlinked skill folders:** `/skills` may not list them, and a Claude Code update may remove the link. Both come from user reports on GitHub. If the skill goes missing, run `./install.sh` again, or use `--copy`.
- **File size:** each report is about 12 MB, because the viewer includes every Shiki language grammar so any stack gets syntax colors.
