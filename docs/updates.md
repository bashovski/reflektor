# Updates (plan)

Status: built in pr-report (skill/scripts/version.mts, release.mts, install.mts, updates.mts, the daemon's update routes, review.mjs version/update/rollback, install.sh, install.ps1, the release workflow and the update modal) and in reflektor-platform (`GET /pr-report/version` and the 426 on publishing). Waiting on: the repo going public (or releases served by the platform), the `PR_REPORT_RELEASE_KEY` secret, and a test of install.ps1 on Windows.

## Why

pr-report is installed by cloning this repo and running `./install.sh`, which builds from source. There is no version number, no release and no way to learn that a newer version exists. In launch week fixes will ship daily, and someone who hit a bug on day one has to keep getting it until they rebuild by hand.

The goal: a one-line install from a published release, a cheap check against Reflektor for a newer version, and an update that the user triggers from a modal and that takes effect right away.

## Decisions

- **Releases on GitHub.** Each version is a GitHub Release with the built skill as a tarball, its SHA-256 and a signature. Nobody needs pnpm or a build to install or update.
- **Signed.** Releases are signed with an Ed25519 key that lives only in CI secrets. The public key ships inside the installer and the skill. A checksum from the same release would not help if the GitHub account were taken over; the signature does.
- **The check goes to Reflektor**, not GitHub: `GET /pr-report/version` on the platform API. It is one cached request and carries no user or machine ID.
- **Updates are forced.** "Update now" stops what is running (open waiters, live pages), installs, and restarts the daemon on the new version. The modal says so before the user confirms. Comments, drafts and reviews are saved on disk and survive the restart.
- **Skill, daemon and viewer are one version.** They ship and update together and can never be out of step.
- **Dev installs never self-update.** A skill linked to a checkout's `dist/skill/` (today's `pnpm run deploy`) keeps working as now and shows no update prompts.

## Before starting

1. **The repo is private.** Release downloads without a token need a public repo. Either make `bashovski/pr-report` public before launch, or serve the release files from the platform (same URLs behind `reflektor.dev/releases/…`). The rest of the plan is the same either way.
2. **Version numbering.** Proposed: start at `0.9.0` for the soft launch and `1.0.0` for the public launch on Dec 1.
3. **Signing key.** Generate an Ed25519 key pair, put the private key in the repo's Actions secrets, and commit the public key.

## Building it while the repo is private

Everything except the final anonymous download can be built and tested now.

- **One configurable source.** The installer, the daemon and the platform all read releases from one base URL: a `RELEASES_URL` constant defaulting to `https://github.com/bashovski/pr-report/releases/latest/download`, overridden with `PR_REPORT_RELEASES_URL`. The platform has the same setting, `PR_REPORT_RELEASES_URL`. Going live is a matter of making the repo public, or pointing the URL at the platform, with no code change.
- **A local release server.** `scripts/release-stub.mts` packs `dist/skill/` the way the workflow does, signs it with a dev key, and serves `manifest.json`, the signature and the tarball on a local port. The check suite uses it, and so does local testing: `PR_REPORT_RELEASES_URL=http://127.0.0.1:<port> ./install.sh`.
- **The dev key is trusted only by dev builds.** A release build (a semver version) knows only the production public key, so a stub release can never be installed over a real one. A dev build (`0.0.0-dev+…`) also accepts the dev key.
- **The release workflow runs now** on the private repo and publishes releases there. `gh release download` with your token can fetch them for a real end-to-end test of the files CI produces.
- **The platform endpoint** reads `manifest.json` from `PR_REPORT_RELEASES_URL`. Locally that's the release server; in production it's whichever public source is chosen.

What waits for the decision: the anonymous `curl -fsSL https://reflektor.dev/install.sh | sh` against real releases, and the README install line.

## How it works

### 1. Versions and releases

- `package.json` gets a real `version`. `build-skill.mts` writes it into `dist/skill/build.json` next to `builtAt` and `commit`.
- The daemon's `VERSION` (today a hash of `daemon.mts`) becomes the semver from `build.json`. A dev build reports `0.0.0-dev+<commit>`, so the existing restart-on-new-code logic in `review.mts` `ensureDaemon` keeps working for development.
- A GitHub Actions workflow on a `v*` tag: install, `pnpm check`, `pnpm build`, pack `dist/skill/` as `pr-report-<version>.tar.gz`, then write `manifest.json` (`version`, `sha256`, `size`, `publishedAt`, `notes`: up to 3 short lines) and `manifest.json.sig` (Ed25519 over the manifest bytes). It uploads all three plus `install.sh` and `install.ps1` to the release.
- `notes` come from a `## Notes` section in the tag's release text, so the modal shows the same 3 lines the release page does.

### 2. Install from a release

- New `install.sh` (macOS, Linux, Git Bash) and `install.ps1` (Windows), served as `https://reflektor.dev/install.sh`:

  ```bash
  curl -fsSL https://reflektor.dev/install.sh | sh
  ```

- Both need only Node.js and git, as today. They download `manifest.json` and its signature from `releases/latest/download/`, verify the signature with an inline `node -e` script holding the public key (Node's `crypto.verify` supports Ed25519), download the tarball, check its SHA-256, and unpack it.
- **Layout:** each version unpacks into its own folder, `~/.pr-report/versions/<version>/`. `~/.claude/skills/pr-report` becomes a link (a junction on Windows) to the current version's folder. `~/.agents/skills/pr-report` gets a copy with the portable `SKILL.md`, as `deploy.mts` does today.
- `~/.pr-report/install.json` records `{ version, targets, installedAt, previous }`. Its absence means a dev install.
- The install and switch-over logic moves from `scripts/deploy.mts` into the shipped skill as `skill/scripts/install.mts`, so an installed skill can update itself without the repo. `deploy.mts` imports it for dev installs.
- Today's source build moves to `scripts/install-from-source.sh` for contributors.

Because every version has its own folder, an update never overwrites files a running process is using. That avoids the Windows problem of replacing files that are in use; only the link is swapped.

### 3. The version endpoint on Reflektor

In reflektor-platform:

- `GET /pr-report/version` returns `{ latest, minimum, notes, notesUrl, publishedAt }`. No auth.
- `latest`, `notes` and `publishedAt` come from the latest GitHub Release's `manifest.json`, fetched by the API and cached in Redis for 10 minutes, so a release shows up without a deploy. `minimum` comes from a `PR_REPORT_MIN_VERSION` env var.
- The response carries `Cache-Control: public, max-age=300` so the CDN answers most checks.
- **Publishing:** the daemon sends `x-pr-report-version` on every upload. When it is below `minimum`, the publish route answers `426` with `{ error: 'update_required', minimum }`. Dev versions (`0.0.0-dev+…`) are always accepted.
- The privacy policy mentions the check: it sends the version and nothing else.

### 4. The daemon: checking and updating

**Checking**
- Every hour in the background, plus on start when the last check is over an hour old, the daemon calls the version endpoint of the Reflektor API it is configured with (`reflektorConfig`, default `https://api.reflektor.dev`), whether or not the user is signed in. Each check waits a random 0–5 minutes so installs don't all hit the API on the hour. It sends `If-None-Match` with the last `ETag`, so an unchanged answer is a `304` with no body.
- The daemon exits after 4 idle hours, so nothing is checked while it isn't running. The next start catches up.
- A failed check (offline, self-hosted with no endpoint) is silent, keeps the last good answer and tries again on the next hour.
- Dev installs skip the check.

**State: `~/.pr-report/update.json`**

The daemon keeps the file and a copy in memory. It stores only what the server said and what the user did, never an "update needed" flag, because that flag would be wrong the moment the version changes:

```json
{
  "checkedAt": "2026-11-16T10:02:11Z",
  "etag": "\"1.5.0\"",
  "latest": "1.5.0",
  "minimum": "1.2.0",
  "notes": ["…", "…", "…"],
  "notesUrl": "https://github.com/…/releases/tag/v1.5.0",
  "snoozed": { "version": "1.5.0", "until": "2026-11-17T10:05:00Z" },
  "lastError": null
}
```

The status is worked out on every read from this file and the running version:
- `required` when the running version is below `minimum`.
- `available` when it is below `latest`.
- `none` otherwise.

"Later" snoozes that one version for 24 hours. A newer release than the snoozed one prompts again straight away, and `required` ignores the snooze.

**Showing it**
- **Live:** when a check changes the status, the daemon sends an `update` event on the events stream every open page already holds, so open tabs show it within the hour without polling. A page also reads `GET /api/update` when it loads.
- **Modal:** once per version, when the status becomes `available` and the version isn't snoozed. On every page load while `required`.
- **Always visible until updated:** a dot on the avatar in the report and the inbox, and an "Update available: 1.5.0" item at the top of the user menu that opens the modal. When `required`, the item is styled as a notice and a thin banner sits above the report.
- **In the terminal:** `review.mjs` reads `update.json` and, when the status isn't `none`, ends the commands the agent relays to the user (the report link, `status`) with one line: "pr-report 1.5.0 is available. Update from the report's menu, or run review.mjs update." `SKILL.md` tells the agent to pass that line on once per session.

**API** (the same page-token auth as the other page routes):
- `GET /api/update` returns the current version, `latest`, `minimum`, `notes`, `snoozedUntil`, `state` (`idle`, `downloading`, `verifying`, `installing`, `restarting` or `failed`), `error`, and `running`: how many waiters and live pages the update would interrupt.
- `POST /api/update` starts the update.
- `POST /api/update/snooze` hides the prompt for 24 hours.

**Updating, when the user confirms**
1. Download the manifest and signature, verify, download the tarball, check the SHA-256, and unpack into `versions/<new>/`. A failure stops here with `state: failed` and a reason, and nothing changes.
2. Run `install.mts` for every target in `install.json`: re-point the Claude Code link and rewrite the `~/.agents` copy. Update `install.json` and keep `previous` for rollback.
3. Send an `updating` event to every open page over the existing events stream, then close open waiters with a `pr-report-updated` answer.
4. Start the new daemon with `PR_REPORT_TAKEOVER=1`. It waits for the old one to free the port, then takes the same port (`7337` unless `PR_REPORT_PORT` is set), so open tabs keep their URLs. The old daemon closes its server and exits.
5. Pages reconnect, see the new version in `/api/health`, and reload.
6. On its next start, the new daemon deletes old version folders, keeping the current one and `previous`.

**What gets interrupted, and what the user is told**
- **Agent waiters** (`review.mjs wait`): the waiter gets `pr-report-updated` or loses its connection and finds a new version in `daemon.json`. It prints: "pr-report was updated to 1.5.0 while waiting. Your comments are saved. Run /pr-report resume to continue." It exits with a code of its own, and `SKILL.md` tells the agent to relay that line and stop.
- **Checks and screenshot runs** already started by the agent keep running from the old version's folder, which stays on disk until the next start. They finish normally.
- **An agent that already loaded the old `SKILL.md`** keeps its old instructions until the next `/pr-report`. The modal says so.

**From the terminal:** `review.mjs update` does the same as the button. `review.mjs version` prints the current and latest version. `review.mjs rollback` switches back to `previous`.

### 5. The modal

Shown in the report viewer (React, a `<dialog>` like `PurgeDialog`) and in the inbox (`viewer/src/inbox/inbox.ts`), following the design-guidelines skill.

- **When:** as described under "Showing it" above. After "Later", the user menu item and the avatar dot keep the update one click away.
- **Content:** "pr-report 1.5.0 is available. You have 1.4.0." Then the up to 3 notes and a link to the full release notes.
- **Before confirming:** "Updating restarts pr-report now. 2 reviews have an agent waiting; they stop, and your comments are kept. Run /pr-report resume afterwards." The count comes from `running`. When nothing is running, the sentence is just "Updating restarts pr-report now."
- **Buttons:** **Update now** (primary) and **Later** (24 hours).
- **Progress:** the button area shows the `state` steps (Downloading, Verifying, Installing, Restarting). The page reloads on its own when the new daemon answers.
- **Failure:** the modal shows the reason in plain words ("The download's signature did not match, so nothing was installed.") with **Try again** and **Close**. The installed version is untouched.
- **Below `minimum`:** the same modal, but **Later** is gone from the publish flow: "Publishing to Reflektor needs pr-report 1.5.0 or newer." Local reports keep working, and the modal can still be closed outside publishing. A `426` from a publish opens it too.

## Work, in order

| # | Part | Where | Estimate |
| --- | --- | --- | --- |
| 1 | Version in `package.json` and `build.json`, semver `VERSION` with the dev fallback, signing key, release workflow | pr-report | 0.5 day |
| 2 | `install.mts` moved into the skill, versioned folders, `install.json`, `install.sh` and `install.ps1` with signature checks | pr-report | 1 day |
| 3 | `GET /pr-report/version`, the GitHub manifest cache, the `426` on publish, a privacy policy line | reflektor-platform | 0.25 day |
| 4 | Daemon check, `/api/update` routes, takeover restart on the same port, waiter message, `update` / `version` / `rollback` commands, `SKILL.md` lines | pr-report | 1 day |
| 5 | The modal in the viewer and the inbox, the user menu item | pr-report | 0.5 day |
| 6 | Tests (below), README install section, this doc's status | both | 0.5 day |

About 3.5 days in total. Parts 1 and 3 can run in parallel.

## Tests

In `scripts/check.mts`, against a local stub release server (like `reflektor-stub.mts`):

- A signed release installs; a wrong signature, a wrong SHA-256 and a truncated tarball are each refused with nothing changed.
- An update re-points the Claude Code link and rewrites the `~/.agents` copy, and `rollback` restores `previous`.
- The takeover restart keeps the port, an open waiter prints the update message and exits with its code, and a page sees the new version.
- A dev install makes no check and shows no prompt.
- An offline check is silent and leaves `update.json` as it was.

In reflektor-platform's vitest suite: the version endpoint with a stubbed GitHub manifest and its cache, and publish answering `426` below `minimum` and accepting dev versions.

In `scripts/browser-check.mts`: the modal's states (available, confirming with running reviews, progress, failure, minimum).
