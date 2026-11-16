# Handover: test and fix reflektor on Windows

This is for a new Claude Code session on a Windows PC. It was written on 2026-11-09 on a Mac, after commit `2196382` ("Make reflektor work on Windows").

## Your task

1. Get reflektor installed and running on this Windows machine.
2. Run its two test suites, then do one real review with `/reflektor`.
3. Fix anything that breaks on Windows, and keep macOS and Linux working.
4. Report to the user what worked, what broke and what you changed.

**Nothing has run on Windows yet.** Every Windows-only code path listed below was written and reviewed on macOS, and none of them has run.

## What reflektor is

reflektor is a Claude Code skill. `/reflektor` turns a branch's changes into a review page with a summary, a review order, risks, request flows and diffs with notes. The reviewer comments in the page and sends the comments back to Claude, which fixes them in rounds.

The pipeline:

- **`skill/scripts/collect.mts`** reads git and writes `diff.json`.
- **Claude** writes `report.json`.
- **`skill/scripts/build.mts`** checks the report against git and writes one JSON bundle per round.
- **`skill/scripts/review.mts open`** publishes the bundle to a local daemon at `http://127.0.0.1:7337`.
- **`review.mts wait`** runs in the background and wakes Claude when the reviewer does something in the page.

The repo is `git@github.com:bashovski/reflektor.git` (private). `README.md` explains the layout. `skill/SKILL.md` holds the steps Claude follows.

## Set up

You need:

- **Git for Windows**, which includes Git Bash
- **Node.js** 20.19, or 22.12 and newer, to build, as Vite 8 needs (the Mac uses 24.12); the built skill runs on Node 18
- **pnpm** (the Mac uses 10.26)
- **Google Chrome**, for `pnpm check:browser`

Run these in PowerShell:

1. `git clone git@github.com:bashovski/reflektor.git`, then `cd reflektor`.
2. `git ls-files --eol install.sh` should show `w/lf`. If it shows `w/crlf`, `.gitattributes` did not apply. Fix that first.
3. `pnpm build`, then `pnpm run deploy`, should end with "Installed reflektor for Claude Code (link)".
4. `Get-Item $HOME\.claude\skills\reflektor | Select-Object LinkType, Target` should show `Junction` pointing at this repo's `skill` folder.
5. Run `pnpm check`, then `pnpm check:browser`. Each takes 1 to 2 minutes on the Mac.

Run `pnpm run deploy` a second time, then make sure `dist\skill\SKILL.md` still exists. The installer has to remove the old junction itself, never the files the junction points to.

## Confirm these assumptions first

1. **The Bash tool runs in Git Bash.** The Windows design assumes that Claude Code on Windows runs Bash tool commands in Git Bash. If this machine's Claude Code runs them in PowerShell, stop and tell the user, because the design changes.
2. **How the skill folder path looks.** Find out how Claude Code fills in `${CLAUDE_SKILL_DIR}` on Windows: with backslashes, forward slashes, or a `/c/...` path. Look at the exact commands Claude runs during `/reflektor`.
3. **Git Bash is found.** after `pnpm build`, `node -e "import('./dist/skill/scripts/repo.mjs').then(m => console.log(m.gitBash()))"` should print the path to Git's `bin\bash.exe`. It must never print the WSL `C:\Windows\System32\bash.exe`.
4. **The browser opens.** `explorer <url>` should open the default browser at the review page. It's used in `skill/scripts/review.mts:168` and `skill/scripts/build.mts:588`.

## What commit 2196382 changed for Windows

| Problem | Fix | Where |
|---|---|---|
| Git for Windows checks out CRLF, which breaks the bash scripts | `* text=auto eol=lf` | `.gitattributes` |
| The installer was bash only, and `ln -s` in Git Bash copies instead of linking | A Node installer that makes a directory junction | `scripts/deploy.mts` |
| The detached daemon gets its own console window, and closing that window stops it | `windowsHide: true` | `skill/scripts/review.mts:73` |
| The daemon has no console, so each git call (every 15 s) would flash a window | `windowsHide: true` | `skill/scripts/daemon.mts:451` |
| Checks ran in `cmd /c`, which can't run bash syntax and breaks commands with quotes | Run them in Git Bash, falling back to Node's `shell: true` (cmd) | `skill/scripts/checks.mts:299`, `skill/scripts/repo.mts:14` |
| A timeout killed only the shell, so the test runner kept going | `taskkill /pid N /t /f` | `skill/scripts/checks.mts:317` |
| Git Bash drops the backslashes from printed paths that Claude reuses | `shellPath()` prints forward slashes on Windows | `skill/scripts/repo.mts:10`, used in collect, build, checks and review |
| Script paths in SKILL.md were unquoted, which breaks on backslashes and spaces | Quoted; `allowed-tools` lists both the quoted and the unquoted form | `skill/SKILL.md:5` and every command in it |
| Renaming onto a file that another process holds open can fail with EPERM | `replaceFile()` retries for up to about half a second | `skill/scripts/repo.mts:29` |
| The tests could pick WSL's bash | `gitBash()` | `scripts/check.mts:21`, `scripts/browser-check.mts:53` |

## Try a real review

Pick a real repo on this machine that has a feature branch. In Claude Code there, run `/reflektor`. Watch for these:

- **Windows:** no console window appears, either when the daemon starts or every 15 seconds afterwards.
- **Paths:** no mangled paths like `C:Users...` show up in the commands Claude runs.
- **Checks:** results stream into the page. When a check times out, Task Manager shows no `node.exe` or test runner left behind.
- **Daemon:** it keeps running after you close Claude Code. Check that `http://127.0.0.1:7337` still opens.
- **Drift:** edit a file after the report is built. Within about 15 seconds, the page shows "N files changed after this report was built".

## Known risks, not handled yet

- **Reserved names:** `branchSlug()` (`skill/scripts/repo.mts:41`) turns a branch name into a folder name. A branch named `con`, `nul` or `aux`, or one ending in a dot, gives a folder Windows can't create.
- **Drift check cost:** every 15 seconds, each open review runs `git add -A` into a temporary index. Git is slower on Windows, so watch the CPU on a big repo. `REFLEKTOR_DRIFT_SECONDS` sets the interval.
- **Spaces in repo paths:** the "Diff file:" and "Report file:" paths that collect prints aren't quoted. Claude has to quote them when the repo path has spaces.
- **Path comparison:** `review.mts resume` finds a review by comparing folder paths as plain strings (`skill/scripts/review.mts:210`). A different drive-letter case (`c:` versus `C:`) would miss.

## Where things live

- **Daemon log:** `%USERPROFILE%\.reflektor\daemon.log`
- **Daemon state:** `%USERPROFILE%\.reflektor\reviews.json` and `daemon.json`
- **One branch's report files:** `<repo>\.git\reflektor\<branch>\`
- **Stop the daemon:** `node dist/skill/scripts/review.mjs stop`

Environment variables:

- **`REFLEKTOR_HOME`:** the daemon's folder, `~/.reflektor` by default. Set it to a temp folder for experiments, so the user's real reviews stay untouched.
- **`REFLEKTOR_PORT`:** the first port to try, 7337 by default.
- **`REFLEKTOR_IDLE_MINUTES`:** how long the daemon waits before stopping on its own, 240 by default.
- **`REFLEKTOR_DRIFT_SECONDS`:** how often it checks for changed code, 15 by default.
- **`REFLEKTOR_CHROME`:** the path to Chrome, when `pnpm check:browser` can't find it.
- **`CLAUDE_SKILLS_DIR`:** where `deploy.mts` installs the skill. Use a temp folder to test the installer.
- **`CLAUDE_CODE_GIT_BASH_PATH`:** the bash that checks run in, when set.

## How to work in this repo

- **Tests:** before every commit, `pnpm check` and `pnpm check:browser` must pass. The user can re-run them on the Mac afterwards.
- **Commits:** one commit per fix. The subject is a plain-English sentence, and the body is a short bullet list of what changed and why.
- **Push:** only when the user says so. The remote uses SSH.
- **No dependencies:** scripts in `skill/scripts/` use Node built-ins only.
- **Code style:** comments say why, in plain English. Match the code around you.
- **Privacy:** no secrets or personal data in committed files.

## How the user likes answers

- **Start with the next action:** use numbered steps and keep them short.
- **Named things:** put them in bullets with bold names, not in comma lists.
- **Libraries:** prefer proven libraries to hand-rolled infrastructure.
- **What reflektor is for:** helping someone understand AI-made changes fast. A clean review is a good result; finding many bugs isn't the measure.
- **Writing:** plain English, with no em dashes.

## Out of scope

- **Codex support:** looked into, but not started. Don't start it unless the user asks.
- **`ROADMAP.md`:** the "Later" and "Before selling" items wait.

## When you finish

Tell the user:

- which setup and test steps passed
- for each failure, the first error line
- the commits you made, and whether they're pushed
- what still needs a re-run on the Mac
