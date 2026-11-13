# Publishing to Reflektor

Reflektor is the platform where an organization reads its members' reports and comments on them. pr-report publishes
a branch's report there: by itself while the branch's pull request is open, or by hand at any time. Nothing goes up
until you sign in, and nothing from a repository leaves the machine until an admin of one of your organizations has
approved that repository on Reflektor.

The API this follows is in the platform's `docs/reports-and-organizations.md` ("Daemon login", "Upload contract",
"Publishing on pull request creation"). The client is `skill/scripts/reflektor.mts`; the daemon's side is the
"Reflektor" section of `skill/scripts/daemon.mts`.

## Sign in

In a terminal:

```bash
node ~/.claude/skills/pr-report/scripts/review.mjs login
```

It asks Reflektor for a code, opens the approval page in your browser (`--no-open` only prints its address), and
prints the code. Check that the page shows the same code, approve, and the command ends with the account it signed
in as. A code is good for 10 minutes. Denying it, or letting it expire, ends the command with a message saying so.

On a report page, the reader's menu (your avatar, top right) has **Sign in to Reflektor**, which does the same: the
daemon asks for the code, the dialog shows it with a link to the approval page, and it says who you are once you
approved.

The approval page names the client as `pr-report on <this machine's name>`.

### The token file

The login is kept in `~/.pr-report/reflektor.json` (under `PR_REPORT_HOME` when that is set), readable by you only
(mode 0600; Windows has no such modes):

```json
{
  "apiUrl": "https://api.reflektor.dev",
  "appUrl": "https://reflektor.dev",
  "token": "rfk_...",
  "user": { "id": "...", "email": "ada@example.com", "name": "Ada Lovelace" },
  "savedAt": "2026-11-13T09:00:00.000Z",
  "organizations": { "github.com/acme/payments": "acme" }
}
```

- The token goes only to the `apiUrl` it was issued by, whatever the settings say later.
- `organizations` keeps the organization you picked for a repository when several of yours approve it, so the next
  publish does not ask again.
- Every call sends `Authorization: Bearer <token>`. When Reflektor answers 401 the token was revoked or has expired:
  sign in again.

### Who am I, and signing out

```bash
node ~/.claude/skills/pr-report/scripts/review.mjs whoami
node ~/.claude/skills/pr-report/scripts/review.mjs logout
```

`whoami` asks Reflektor whose token this is. `logout` deletes `reflektor.json` and nothing else; Settings on a report
page has **Sign out** too. To end the token on Reflektor's side as well, revoke it on your account page there.

## Publish by hand

```bash
node ~/.claude/skills/pr-report/scripts/review.mjs publish            # this branch's review, found from the folder
node ~/.claude/skills/pr-report/scripts/review.mjs publish --id <review id> --org acme
```

Or **Publish to Reflektor** in the reader's menu on the report page. Both go through the daemon, which:

1. Takes the review's newest round that is not a draft, as the report data file `build.mjs` wrote.
2. Asks Reflektor which of your organizations approve the repository (`POST /reports/preflight`). Only the host, owner
   and name from the bundle's `diff.repo` are sent. With no organization, nothing is uploaded and you are told that an
   admin has to approve the repository first.
3. Picks the organization: the one you named (`--org`, or a button in the dialog), else the one saved for the
   repository, else the only one. With several and none picked, it lists them. In a terminal, `publish` asks which
   one; run by an agent, it prints the list and the command with `--org`.
4. Uploads the bundle, the same object the review page gets, gzipped (`POST /reports`, `Content-Encoding: gzip`).
   Paths on this machine (`diff.repo.root`, `diff.repo.gitDir`, `projectChecks.file`) are blanked before it leaves,
   and the platform blanks them again before it stores the report.
5. Remembers the upload with the review (`uploads` in `review-state.json`), and tells open pages. The menu then says
   which round went where, with a link to it.

Publishing a snapshot that already went up answers with its link instead of sending it again, unless you name another
organization.

## Publish while the pull request is open

Once you are signed in, the daemon publishes by itself:

- when it sees the branch's pull request open, the newest finished round;
- then each round built while the pull request stays open (a new round, or a rebuild with new code).

It never sends a draft, and never the same snapshot twice: what went up is kept per review and survives restarts. It
starts a publish only when the pull request was seen open in the last 10 minutes, so a review left alone for weeks
does not go up on the strength of an old state. The daemon learns about the pull request the way the page does: from
the agent (`review.mjs pr`), from the report when it was built after the pull request opened, and from GitHub while
the review is open in a tab.

Everything runs in the background and never holds up a page or an agent. A publish that did not work is written to
`~/.pr-report/daemon.log`, shown under **Publish to Reflektor** in the menu, and tried again later: after 5 minutes
for a network problem or a server error (or when Reflektor's `Retry-After` says), after an hour for a refusal only a
person can fix (repository not approved, an organization to choose). Signing in again, or a new build, tries at once.

Turn it off in Settings (**Publish while the pull request is open**, shown once you are signed in), or set
`reflektorAutoPublish` to `false` in `~/.pr-report/settings.json`.

## Settings

In `~/.pr-report/settings.json`, beside the other settings the scripts read (`skill/scripts/settings.mts`):

| Key | Default | Means |
| --- | --- | --- |
| `reflektorAutoPublish` | `true` | Publish while the pull request is open. Does nothing until you sign in. |
| `reflektorApiUrl` | `""` | The API to sign in with. Empty means `https://api.reflektor.dev`. Changed in Settings too. |
| `reflektorAppUrl` | `""` | The app. Empty means the one the API's sign-in page is on, which is `https://reflektor.dev` for Reflektor's own. |

The variables `REFLEKTOR_API_URL` and `REFLEKTOR_APP_URL` win over the two URL settings. Only `login` reads them: a
saved login keeps the URLs it was made with. Both must be `https://`, except on this machine (`localhost`,
`127.0.0.1`, `[::1]`), so a token never travels in the clear.

For a self-hosted Reflektor, change the API URL in Settings, under **Reflektor**, while signed out. The daemon checks
it before saving it, and **Reset to default** goes back to `https://api.reflektor.dev`. When no app URL is named, a
login takes the app from the sign-in page the API sends, so links and the account page point at the same Reflektor.

## What can go wrong

| Reason | What it means |
| --- | --- |
| `signed_out` | No login on this machine. Run `review.mjs login`. |
| `unauthorized` | Reflektor answered 401: the token was revoked or expired. Sign in again. |
| `draft` | The newest round is still a draft; the agent has not finished the report. |
| `no_remote` | The repo's remote does not name a host and an owner, so it is not a repository Reflektor knows. |
| `not_approved` | The preflight named no organization. Nothing was uploaded. |
| `organization_required` | Several of your organizations approve the repository. Pick one. |
| `unknown_organization` | The organization you named does not approve the repository. |
| `repository_not_approved`, `not_a_member` | The upload was refused (403). |
| `invalid_bundle` | The platform's validation refused the report (400); the first issues are named. |
| `too_large` | Over the platform's 25 MB (gzipped) limit (413). |
| `rate_limited` | Too many publishes (429); tried again when `Retry-After` says. |
| `network` | Reflektor could not be reached, or did not answer within 15 seconds (2 minutes for the upload). |

## The daemon's routes

For the page (page token, `x-review-token`): `GET /api/reflektor` (signed in as whom, the app URL, the setting, a
sign-in waiting for approval), `POST /api/reflektor/login`, `POST /api/reflektor/logout`, and
`POST /api/r/<id>/reflektor` with `{ "organization"?: slug }`. `review.mjs publish` calls the last one with the
admin token. Each review's live state carries `reflektor: { published, error, publishing }`.

## Testing

`pnpm check` runs the client, `review.mjs login`, `whoami`, `logout` and `publish`, and the daemon's own publishing
against `scripts/reflektor-stub.mts`, a local stand-in for the API. `pnpm check:browser` signs in and publishes from
the report page's menu against the same stand-in. Neither talks to the real Reflektor.

Against a platform running on your machine (its API on port 3000, its app on 5173 by default):

```bash
export REFLEKTOR_API_URL=http://localhost:3000 REFLEKTOR_APP_URL=http://localhost:5173
node ~/.claude/skills/pr-report/scripts/review.mjs login
```
