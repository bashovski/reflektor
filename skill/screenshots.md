# Screenshots

collect.mjs sends you here when the reader turned on Screenshots in Settings and the change touches UI files. The report gets pictures of what changed on screen, taken with Playwright while you write it. They never hold the report up.

## Start the subagent (the main agent)

Skip this when nothing a user sees changed, for example a refactor with the same output or styles nobody can see yet. Otherwise:

1. Check what is ready:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/screenshots.mjs" --repo . --status
   ```

   - **Playwright or Chromium is missing:** skip the screenshots and say in your final message which command installs it. Record why, so the page says it too: `screenshots.mjs --repo . --skip "<reason>"`.
   - **No app is saved:** work it out once. Find the dev server's address and the command that starts it in package.json scripts and the dev server's config (vite.config, next.config, and so on). Save it, naming the files it came from. Do not ask first.

     ```bash
     node "${CLAUDE_SKILL_DIR}/scripts/screenshots.mjs" --repo . --save --url http://localhost:5173 --start "pnpm dev" --source "<where from>" --from package.json
     ```

   - **It says to ask the user first:** the branch has commits by someone else and the app runs their code. Ask in one line, as for the checks. On a yes, the subagent adds `--trust` to `--prepare`.

2. Start one subagent in the background (in Claude Code: the Agent tool with `run_in_background`), then go on with the report. Do not wait for it. Tell it:
   - the repo path and the base, the changed UI files from collect's table, and why the change was made, in two or three sentences
   - the routes or pages you know the change touches, if any
   - to read this file, by its full path, from "The subagent's work" on
   - a plan from an earlier round, when `--status` named one
   - that it must not change code or commit

If you cannot start a subagent that runs in the background, skip the screenshots for this report and say so.

When the subagent ends, the page already shows its shots. Its answer lists them. You need not change report.json for them.

## The subagent's work

`screenshots.mjs` takes the pictures. Run every command from the repo root with `node "<skill dir>/scripts/screenshots.mjs" --repo .`, where the skill dir is the folder this file is in.

### 1. Get the app ready

```bash
node "<skill dir>/scripts/screenshots.mjs" --repo . --prepare
```

This reaches the app or starts it, then runs the project's `preScreenshots` hook, which can sign a test user in. Its last lines say whether signed-in pages can be shown. If it says it stopped and recorded why, end here and report that reason.

### 2. Decide what to show

Read the changed UI files and work out what a user sees differently. Then pick sets, at most 12 shots in all:

| Shape | When | Example |
| --- | --- | --- |
| `flow` | The change spans several screens a user moves through | Sign up, verify the email, land on the dashboard |
| `states` | One page shows the change in several states | The reports list: empty, filtered, with an error |
| `single` | One visual change | A new badge on the report header |

Prefer one good set over many. A change to one component often needs one `single` shot, of a page that shows it. Every shot must show something a changed file draws; leave out pages the change does not reach, and changes no picture can show (a browser tab's title, a log line).

When `--status` names a plan from an earlier round and the main agent handed it to you, run it again first (step 4) and change only the steps that fail or no longer cover the change. Without one, start a new plan.

Look at a page before you plan it:

```bash
node "<skill dir>/scripts/screenshots.mjs" --repo . --inspect /settings [--auth signed-in]
```

It prints the address after redirects, the title, the page's accessibility tree, any errors, and the path of a picture of the page. Look at the picture with your file reading tool. Take selectors from the tree.

To see the page where a set's steps leave it, for example after a click opens a menu, inspect after a step of your plan:

```bash
node "<skill dir>/scripts/screenshots.mjs" --repo . --inspect --plan <plan.json> --after <set id>:<step number>
```

### 3. Write the plan

Write `plan.json` in the scratch folder you were given, or next to `screenshots.json` when you have none:

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
        { "do": [{ "goto": "/organizations" }], "shot": "Invite button added to the Organizations header", "refs": ["src/pages/Organizations.tsx:42"] },
        { "do": [{ "click": "role=button[name='Invite']" }], "shot": "The new invite dialog" },
        {
          "do": [{ "fill": ["role=textbox[name='Email']", "teammate@example.test"] }, { "click": "role=button[name='Send invite']" }],
          "shot": "The pending invite shows in the members list"
        }
      ]
    }
  ]
}
```

- **Actions:** `goto` (a path on the app), `click`, `fill` ([selector, text]), `press` (a key, or [selector, key]), `select` ([selector, value]), `check`, `uncheck`, `hover`, `waitFor` (a selector), `scroll` (a selector or pixels). Steps of a set run in one browser tab, one after another, so a flow carries on from the step before.
- **Selectors** are Playwright's. Prefer `role=button[name='Save']` and `text=Saved` over CSS. A quoted `name` must be the element's whole accessible name, as the tree prints it; for part of a name, use a pattern: `role=menuitem[name=/View all reports/i]`.
- **`fullPage: true`** on a step takes the whole page instead of the window.
- **Signed in:** `"auth": "signed-in"` uses the test login from `--prepare`. When it said the hook wrote credentials instead of a session, add `"login": { "path": "/login", "do": [{ "fill": ["role=textbox[name='Email']", "$username"] }, { "fill": ["role=textbox[name='Password']", "$password"] }, { "click": "role=button[name='Sign in']" }] }` to the plan. `$username` and `$password` stand for the credentials; never write the real ones. Run `--login --plan <plan.json>` once before you inspect signed-in pages.

### Captions

Every word in the plan is shown to the reviewer.

- **Set title:** what the user does or sees, in a few words: "Inviting a teammate".
- **Set summary:** one sentence on what the change does for the user. Required for a flow.
- **Shot caption (`shot`):** what changed on this screen, not what the screen is. "Invite button added to the Organizations header", not "The Organizations page". About 12 words at most. In a flow, the captions read as steps, in order.
- **Refs:** up to 3 per shot, as `path:line`, the changed lines behind what is on screen. Only files the branch changes; others are left out.
- **Never** credentials, session data, or personal data the app shows. Write "a test user", not a name or an email.

### 4. Take the shots

```bash
node "<skill dir>/scripts/screenshots.mjs" --repo . --run --plan <plan.json>
```

It takes every shot, writing `screenshots.json` after each, so the review page shows them as they come. Then it runs the project's hooks after screenshots and stops the app if it started it.

Look at every picture it lists. When a picture does not show what its caption says, or a step failed, fix the plan, run `--prepare` again, then `--run` again. Twice at most. A shot that still fails stays in the report with its error.

A failed step says whether nothing matched its selector or something matched but could not be acted on, and why. `--run` stops the app it started and runs the project's hooks after it, which may end the test login, so run `--prepare` again before you inspect signed-in pages after a run.

### 5. Answer

Send back, in a few lines: how many shots were taken out of how many, each set's title, and anything that failed or was skipped, with why. Do not change code, run tests, or commit.
