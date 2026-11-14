# Screenshots (spec)

Status: proposed, not built. Replaces the "Before/after screenshots" line in ROADMAP.md.

## Why

A diff shows what changed in the code, not what changed on screen. When a branch changes UI, the report should show it: the screens of a flow in order, the states of a page, or the one thing that changed. The reviewer sees the result before reading the code.

## What it is

- Screenshots, not video. One image per step or state, each with a caption.
- The agent works out what to capture from the change. Nobody writes test scripts for it.
- Playwright takes the shots. It is optional: an integration the user turns on in the setup wizard or in Settings. Off by default.
- It never holds anything up. A subagent captures in the background while the report is written, and shots appear on the page as they are taken, the way project checks do today.
- Only the branch's version is captured. No before/after pairs in v1.

## Three shapes

The subagent picks one shape per group of shots, called a set. A report can have several sets.

| Shape | When | Example |
| --- | --- | --- |
| `flow` | The change spans several screens a user moves through | Sign up, verify email, land on the dashboard |
| `states` | One page with several visual changes or states | Reports list: empty, filtered, with an error |
| `single` | One visual change | A new badge on the report header |

Limits: at most 12 shots per report, one desktop viewport (1280 by 800). Nothing is captured when the change has no UI.

## Turning it on

### The setting

`screenshots: false` joins the settings in `~/.pr-report/settings.json` (`skill/scripts/settings.mts`). collect.mjs prints it, like `subagents`, so the agent knows whether to start the subagent.

### Finding Playwright

The daemon answers `GET /api/setup/playwright`:

```json
{ "playwright": { "found": true, "version": "1.56.0", "from": "global" }, "chromium": { "found": true } }
```

- **Playwright:** whichever is installed. A repo's own `playwright` or `@playwright/test` comes first at run time, then a global install. The daemon has no repo when the wizard runs, so it checks the global one and the page says that a project's own Playwright counts too.
- **Chromium:** a `chromium-*` or `chromium_headless_shell-*` folder in `PLAYWRIGHT_BROWSERS_PATH`, or else in Playwright's default cache (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`).

### Wizard step

A new step, "Screenshots", after "Faster reports?". Like the tools step, it asks the daemon every few seconds while it is open.

- Says in one line what it does and that it costs extra tokens.
- Shows Playwright and Chromium as found or missing. For missing ones it shows the command with a copy button: `npm install -g playwright`, then `npx playwright install chromium`.
- One switch, off. It can be turned on only once both are found.

### Settings section

"Screenshots" gets its own section in Settings, with the same status, install commands and switch. Turning it off is one click and takes effect on the next report.

When the setting is on but Playwright disappears, the next report skips screenshots and the page says why in the Screenshots section. The setting stays on.

## Reaching the app

The app's address and how to start it come from `.pr-report.json`:

```json
{
  "screenshots": {
    "url": "http://localhost:5173",
    "start": "pnpm dev",
    "readySeconds": 60,
    "hosts": ["localhost", "127.0.0.1"],
    "upload": true
  }
}
```

- If something answers at `url`, it is used as it is.
- If not, and `start` is set, screenshots.mjs starts it in the repo root, waits up to `readySeconds` for `url` to answer, and stops it when done.
- If neither works, the run is skipped and the reason shows in the report.
- Without the `screenshots` block, the agent works the values out once from the repo (package.json scripts, the dev server's config) and saves them in `~/.pr-report/repos/`, the same way it saves checks. `screenshots.mjs --share` copies them into `.pr-report.json`.
- `hosts` limits where the browser may go. The default is localhost addresses and names ending in `.localhost` or `.test`. A request to any other host is blocked, and the shot that needed it fails.

## Signed in or signed out

Every set says `auth: "signed-in"` or `auth: "signed-out"`.

- **Signed out:** a fresh browser context with no cookies.
- **Signed in:** a context loaded from a Playwright storage state file that the `preScreenshots` hook writes.

The hook is where the project sets up a safe test login. It runs once per screenshot run, before any shot. Typical uses: seed the database, create a test user, sign in with a script, and save the session with Playwright's `storageState({ path })` to `$PR_REPORT_AUTH_STATE`.

When the hook can't sign in itself, it may instead write `{ "username": "...", "password": "..." }` to `$PR_REPORT_AUTH_CREDENTIALS`. The subagent then signs in through the app's own login page, saves the session, and uses it for every signed-in set. These are test credentials for the local app only. They never go into the report, a caption, the page or Reflektor.

With no hook, signed-in sets are skipped, and the report says that a `preScreenshots` hook would enable them.

## Hooks

Four new hooks in `.pr-report.json`, run by screenshots.mjs through `runHooks` in `skill/scripts/hooks.mts`. Like the others, they don't run while the branch has commits by untrusted authors.

| Hook | When | On failure | Time limit |
| --- | --- | --- | --- |
| `preScreenshots` | Before the first shot | Signed-in sets are skipped, signed-out sets still run | 300s |
| `onScreenshotsPassed` | Every planned shot was taken | Warning | 120s |
| `onScreenshotsFailed` | At least one shot failed, or the run could not start | Warning | 120s |
| `postScreenshots` | Always, after the two above | Warning | 120s |

Every screenshot hook gets the usual `PR_REPORT_HOOK`, `PR_REPORT_BRANCH` and `PR_REPORT_BASE`, plus:

- `PR_REPORT_APP_URL`: the app's address
- `PR_REPORT_SCREENSHOTS_DIR`: the folder the shots go in
- `preScreenshots` only: `PR_REPORT_AUTH_STATE` and `PR_REPORT_AUTH_CREDENTIALS`, the two paths it may write
- the three after the run: `PR_REPORT_SCREENSHOTS` (the path of screenshots.json) and `PR_REPORT_SCREENSHOTS_RESULT` (`passed` or `failed`)

Example:

```json
"hooks": {
  "preScreenshots": "node scripts/e2e-login.mjs",
  "onScreenshotsFailed": "echo 'screenshots failed' >&2",
  "postScreenshots": "pnpm db:reset:test"
}
```

## How a run goes

1. **collect.mjs** says screenshots are on and lists the changed UI files (the `frontend` target, or files that look like pages, components and styles).
2. **The main agent** starts one subagent in the background with a brief: the repo, the changed UI files, why the change was made, the app settings, and to read `skill/screenshots.md`. It goes on writing the report and doesn't wait.
3. **The subagent:**
   1. runs `screenshots.mjs prepare`, which reaches or starts the app and runs `preScreenshots`
   2. runs `screenshots.mjs inspect --path /reports` for each page it needs to understand. That prints the page's accessibility tree and saves a screenshot it can look at. Look first, then act.
   3. picks the sets and writes a capture plan (below)
   4. runs `screenshots.mjs run --plan plan.json`. If a step fails, it reads the error, fixes that step, and runs again, at most twice.
4. **screenshots.mjs run** captures every set, writing PNGs and `screenshots.json` as it goes, then runs the after hooks and stops the app if it started it.
5. **The daemon** watches `screenshots.json` like `checks.json` and streams each new shot to open pages.
6. **Next round:** the plan is kept in the report folder. The next round runs it again with no exploring. The subagent revises it only when a step fails or the round changed UI files the plan doesn't cover.

### Capture plan

```json
{
  "sets": [
    {
      "id": "invite",
      "shape": "flow",
      "title": "Inviting a teammate",
      "summary": "Admins can now invite a teammate by email from the Organizations page.",
      "auth": "signed-in",
      "steps": [
        {
          "do": [{ "goto": "/dashboard/organizations" }],
          "shot": "Invite button added to the Organizations header",
          "refs": ["apps/ui/src/pages/OrganizationsPage.vue:42"]
        },
        { "do": [{ "click": "role=button[name='Invite']" }], "shot": "The invite dialog" },
        {
          "do": [{ "fill": ["role=textbox[name='Email']", "teammate@example.test"] }, { "click": "role=button[name='Send invite']" }],
          "shot": "The pending invite in the members list"
        }
      ]
    }
  ]
}
```

- Actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `hover`, `waitFor` (a selector or text), `scroll`.
- Selectors are Playwright's, with role and text selectors preferred over CSS.
- Before each shot, the script waits for the network to go quiet and for fonts to load, then takes the shot. It never waits a fixed time.
- `shot` is the caption the reader sees. `refs` are optional `path:line` references to the changed code behind what the shot shows.

### Captions

The subagent writes every word the reader sees. The rules, also in `skill/screenshots.md`:

- **Set title:** what the user does or sees, in a few words ("Inviting a teammate").
- **Set summary:** one sentence on what the change does for the user. Required for flows, optional otherwise.
- **Shot caption:** what changed on this screen, not a description of it. "Invite button added to the Organizations header", not "The Organizations page". At most about 12 words. In a flow the captions read as steps, in order.
- **Refs:** the changed files and lines behind what is on screen, at most 3 per shot, each one a line in the diff.
- **Never** test credentials, session data or personal data the app shows. Write "a test user", not the user's name or email.

### screenshots.json

```json
{
  "status": "done",
  "result": "failed",
  "startedAt": "2026-11-15T10:00:00Z",
  "ranAt": "2026-11-15T10:01:12Z",
  "skipped": null,
  "sets": [
    {
      "id": "invite",
      "shape": "flow",
      "title": "Inviting a teammate",
      "summary": "Admins can now invite a teammate by email from the Organizations page.",
      "auth": "signed-in",
      "shots": [
        {
          "id": "invite-1",
          "caption": "Invite button added to the Organizations header",
          "refs": ["apps/ui/src/pages/OrganizationsPage.vue:42"],
          "file": "shots/invite-1.png",
          "width": 1280,
          "height": 800
        },
        { "id": "invite-3", "caption": "The pending invite in the members list", "file": null, "error": "Timed out waiting for role=button[name='Send invite']" }
      ]
    }
  ]
}
```

`status` is `running` or `done`. `skipped` holds a reason when nothing ran, such as Playwright missing, the app unreachable, or the setting off.

## In the report

A **Screenshots** section, shown when screenshots.json exists, placed after Flows. It also gets an entry in the sidebar.

- One group per set: its title, shape label, auth label and summary, then its shots as thumbnails in order, each with its caption. A flow's thumbnails are numbered.
- A shot's refs show under its caption as code links. Clicking one goes to that line in the diff.
- While running: a running label and grey placeholders for shots not taken yet.
- A failed shot shows its caption and the error instead of an image.
- Skipped: one line with the reason and what fixes it (for example, "Playwright was not found. Install it from Settings → Screenshots.").

**Viewer:** clicking a thumbnail opens it full size over the page.

- ← and → buttons, and the arrow keys, step through every shot in the report, across sets.
- A counter ("3 / 8"), the set title, the caption and the refs.
- Esc, the close button or a click on the backdrop closes it, and focus returns to the thumbnail.
- The arrow keys don't reach the page's own shortcuts while it is open.
- The shapes follow DESIGN.md: square blocks, `rounded-control` buttons and `shadow-float` on the overlay.

## Reflektor

On publish, the shots upload with the round. Uploading is on unless the repo turns it off with `screenshots.upload: false` in `.pr-report.json`. The page's publish confirmation says how many screenshots will be uploaded.

- **Platform API:** an upload endpoint per round that takes PNGs and stores them in object storage. The bundle's screenshots point at the stored URLs. This needs object storage from the hosting work in TASKS.md.
- **Platform UI:** the same section and viewer, ported to `apps/ui/src/report` through the renderer sync.
- **Never uploaded:** the auth state file, the credentials file and the capture plan.

## Safety

- Hooks run the branch's code, so the trust rule applies to them as it does to checks.
- The browser only goes to the hosts in `hosts`.
- Test credentials and session files stay in the report folder on the user's machine.
- Screenshots can show whatever data the app holds, so `preScreenshots` should seed test data. The README says so, and so does the upload opt-out.

## Cost

Only when the setting is on and the change has UI files. The subagent's tokens go mostly to inspecting pages. A reused plan costs almost nothing.

## Build order

| Step | What | Time |
| --- | --- | --- |
| 1 | Setting, `/api/setup/playwright`, wizard step, Settings section | 1h |
| 2 | `screenshots.mjs` (`prepare`, `inspect`, `run`, `--save`, `--share`), app start and stop, the four hooks | 2h |
| 3 | SKILL.md step and `skill/screenshots.md` (the subagent's instructions) | 1h |
| 4 | Report section and viewer, daemon streaming | 1h |
| 5 | `pnpm check` fixture (a small static app with a sign-in page), then real runs on reflektor-platform and reflektor-examples | 1h |
| 6 | Reflektor upload and platform renderer, after object storage exists | 1 to 2h |

## Not in v1

- Before/after pairs from the base branch
- Video or GIFs
- Mobile viewports and dark-mode shots
- Comments on a screenshot
