# Roadmap

## Done

- PR description from the report
- Secret and migration checks
- Plan check: did the change do what the session planned
- Project checks: run the repo's lint, typecheck and test commands in the background; the report opens right away and each result streams in live
- Schema diagram for database changes
- Types and contracts: new, changed and removed types, interfaces, enums and constants, checked against the code
- Live questions while reviewing
- Review daemon: one address for every review, an inbox, live plan, live progress per comment, new rounds as a banner
- Tab title "branch · repo" with a status icon; a red dot and blinking title for news while the tab is in the background
- Owner avatars in the header and the inbox (github.com and gitlab.com, downloaded once; initials elsewhere)
- Whole branch every round, with a "since round N" view; the last report carried forward with its line references moved; PR description only from whole-branch reports
- Reviews outlive their session: the page says when no session is listening, and `/pr-report resume` picks the review up; events stay until the agent acts on them
- Drift warning: the page lists files changed after the report was built and can ask the agent for an update
- Draft page with the facts while the agent writes the report
- Inbox archive, restore and delete; one report folder per branch
- Inbox grouped by repo owner, with group, sort and filter menus, fuzzy search (Fuse.js), and colored type pills with icons
- Owner menu in the review page: the owner's page, all reports, and the branch's pull request, or a new one filled in from the report
- Live pull request state: told by the agent when it opens one, polled from GitHub with ETags while the page is open; a state pill in the header, a banner and done before-merge items on merge, a merged status in the inbox
- Project checks ask first when the branch has commits by someone else
- Speed: diffs render only near the screen, code colored with WebAssembly lexers, the daemon serves the viewer as cached files and each report is only its data (44-file change: 2.4 s frozen and 161 MB before, under 0.3 s and 37 MB after)
- Any agent, by name: the page and the inbox name the agent on the other side (`skill/agents.json`, worked out in the agent's shell and sent with every call) and say "your agent" when nobody told them
- Installs for agents other than Claude Code: `pnpm run deploy --target agents` puts a copy with its own `SKILL.md` in `~/.agents/skills`, the folder Codex reads
- Hooks: `preRun`, `postRun` and `onApproved` commands in `.pr-report.json`, run by the scripts with `PR_REPORT_*` variables, and held back like the checks while the branch has commits by authors not yet trusted
- Screenshots of the changed UI: off until turned on in the wizard or Settings, which check for Playwright and a browser; a background subagent writes a capture plan (flows, states, single changes, with captions and code links), `screenshots.mjs` takes the shots, and the page shows them as they come, with a full-size viewer. `preScreenshots` sets up a test login; `onScreenshotsPassed`, `onScreenshotsFailed` and `postScreenshots` follow (`docs/screenshots.md`)
- Publish to Reflektor: sign in with the device flow (`review.mjs login`, or the reader's menu), the token in `~/.pr-report/reflektor.json` for the user only; publish by hand (`review.mjs publish`, the menu) or by itself while the pull request is open, once per snapshot, never a draft, and only after the preflight names an organization that approves the repo (`docs/reflektor.md`)

## Later (remind)

- **A whole review with a second agent:** run one end to end with Codex, then add its detection markers to `skill/agents.json`. Only Claude Code's are checked against the real tool so far.
- **LGTM opens the pull request** as a setting, for everyone without an `onApproved` hook.
- **More hook points when someone needs them:** `postCollect`, `onChecksDone`, `onReviewSent`, and personal hooks in `~/.pr-report` for all of a user's repos.
- **Checks without a base:** when no base branch is found, `untrustedAuthors()` cannot tell whose commits are on the branch. Hooks then do not run; the checks still do.
- **A neutral `PR_REPORT_BASH`:** `gitBash()` reads only `CLAUDE_CODE_GIT_BASH_PATH` before it searches for Git Bash on Windows.
- **Screenshots on Reflektor:** upload a round's screenshots with it (unless `.pr-report.json` says `"upload": false`) and show them on the platform, once it has object storage. The local part is done: `docs/screenshots.md`.
- **Tests on other stacks:** fake repos in Go, Python and Rust run by `pnpm check`, to prove the skill works for any stack.
- **Reflektor in the inbox's menu:** signing in and publishing are in a report's menu, and the account in Settings. The inbox's hand-written menu has no Reflektor block yet.
- **Auto-publish for reviews not on screen:** the daemon follows a pull request only while its review is open in a tab, or when the agent tells it (`review.mjs pr`). A pull request opened elsewhere publishes once a tab of its review is open.
- **Smaller exported pages:** `build.mts --html` still writes about 11 MB, almost all of it Shiki grammars kept as a fallback for browsers without WebAssembly. Drop them, or embed only the languages the diff uses. Reports opened through the daemon are not affected.

## Open decisions

- **Dependency check:** the agent lists changed packages, OSV.dev and deps.dev supply versions, vulnerabilities and licenses. Waiting on answers about scope, online lookups, blocking, and release age.
- **"Do this" on before-merge items the agent cannot do** (run a production migration, set a production env var): show "Got it" instead.
- **Duplicate items:** the same task can appear as a highlight and as a before-merge item.

## Not now

- Sharing reports with teammates (link, CI artifact, PR comments). Held back while this is planned as a product.

## Before selling

- Add a third-party notices file. The page bundles @pierre/diffs (Apache-2.0), the inbox serves Fuse.js (Apache-2.0), React, Headless UI, Tailwind and atom-material-icons (MIT), Lucide (ISC) and the Geist fonts (OFL-1.1). Apache-2.0 and MIT require shipping their license texts.
- User-defined safety rules (pattern, severity, message) next to the fixed secret and migration checks, and an instructions file appended to the style guide. No code plugin API until report.json, the bundle and the daemon API stop changing, and third-party code never runs inside the daemon or the viewer.
