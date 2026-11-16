// Reflektor, the platform where an organization reads its members' reports and comments on them. This file is the
// client of its API that review.mjs and the daemon share. The contract is in the platform's
// docs/reports-and-organizations.md ("Daemon login", "Upload contract", "Publishing on pull request creation"):
//
//   login     the device flow, like `gh auth login`: the browser approves, this machine gets a token
//   whoami    the account the token belongs to
//   publish   preflight (does one of my organizations approve this repository?), then the bundle, gzipped
//
// The token is kept in ~/.pr-report/reflektor.json, readable by the user only, with the API it was issued by. Every
// later call goes to that API, whatever the settings say by then, so a token is never sent anywhere else. A call that
// fails throws a ReflektorError with a sentence the reader can act on; publishBundle() never throws at all and answers
// with an outcome, because the daemon runs it in the background.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Bundle, Review } from "../schema/types.js";
import { replaceFile } from "./repo.mjs";
import { readSettings, type Settings } from "./settings.mjs";
import { skillVersion } from "./version.mjs";

// The account a token belongs to, as POST /auth/device/token and GET /auth/me name it.
export type ReflektorUser = { id: string; email: string; name: string | null };
// ~/.pr-report/reflektor.json. `organizations` keeps, per repository ("github.com/acme/payments"), the organization
// the user picked when several of theirs approve it, so the next publish does not ask again.
export type ReflektorLogin = { apiUrl: string; appUrl: string; token: string; user: ReflektorUser; savedAt: string; organizations?: Record<string, string> };
// Where to sign in: the API, and the app whose pages the reader opens.
// `appUrlSet` is false when the app URL is Reflektor's own only because nothing named another: a login then takes the
// app from the sign-in page the API sends.
export type ReflektorConfig = { apiUrl: string; appUrl: string; appUrlSet?: boolean };
export type Organization = { slug: string; name: string };
// A repository as preflight asks about it: the bundle's diff.repo.
export type Repository = { host: string; owner: string; name: string };
// What POST /auth/device answers. Both times are in seconds.
export type DeviceStart = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };
// What POST /reports answers: 201 for a new round, 200 with `created: false` when that snapshot was there already.
export type Uploaded = { report: { id: string; url: string }; round: number; created: boolean; screenshots?: ScreenshotsUploaded };
// The round's screenshots after the report went up: how many pictures were sent, and why some were not. A picture
// Reflektor already has is not sent again.
export type ScreenshotsUploaded = { sent: number; failed: number; error: string | null };
// A call that did not work. `code` is the API's own error ("repository_not_approved", "slow_down") or one of these:
// "network" (no answer), "unauthorized" (401: the token was revoked), "bad_url" (a setting that is not a usable URL),
// "bad_answer" (an answer without what the contract promises), "http" (any other status).
// "update_required" (426) comes with the oldest pr-report Reflektor takes, in `minimum`.
export type ReflektorError = Error & { code: string; status: number | null; organizations?: Organization[]; retryAfterMs?: number; minimum?: string };
// How a publish ended. `reason` is a ReflektorError code, or "draft", "no_remote", "not_approved",
// "unknown_organization", which are found out here before anything is uploaded.
export type PublishOutcome =
  | ({ ok: true; organization: string } & Uploaded)
  | { ok: false; reason: string; message: string; organizations?: Organization[]; retryAfterMs?: number; minimum?: string };

const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
export const LOGIN_FILE = join(HOME, "reflektor.json");
const DEFAULT_API = "https://api.reflektor.dev";
const DEFAULT_APP = "https://reflektor.dev";
export const DEFAULT_REFLEKTOR_API = DEFAULT_API;
// The upload carries the whole bundle, up to 25 MB gzipped; the other calls are small.
const CALL_MS = 15_000;
const UPLOAD_MS = 120_000;
// What the device flow uses when the API leaves a time out: its documented 10 minutes and 5 seconds.
const DEVICE_EXPIRES_S = 600;
const DEVICE_INTERVAL_S = 5;

const gzipped = promisify(gzip);
const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const failure = (code: string, status: number | null, message: string, extra: Partial<ReflektorError> = {}): ReflektorError =>
  Object.assign(new Error(message), { code, status }, extra) as ReflektorError;

// ------------------------------------------------------------------ where

// A base URL without its trailing slash. Only https, except on this machine (a local platform, the check suites'
// stand-in), so a token never travels in the clear.
function baseUrl(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure("bad_url", null, `The Reflektor ${what} URL "${value}" is not a URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw failure("bad_url", null, `The Reflektor ${what} URL must use https: ${value}`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// REFLEKTOR_API_URL and REFLEKTOR_APP_URL, else the settings file (reflektorApiUrl, reflektorAppUrl), else
// Reflektor's own. Only login reads this: a saved login keeps the URLs it was made with.
export function reflektorConfig(settings: Settings = readSettings(), env: NodeJS.ProcessEnv = process.env): ReflektorConfig {
  return {
    apiUrl: baseUrl(env.REFLEKTOR_API_URL || settings.reflektorApiUrl || DEFAULT_API, "API"),
    appUrl: baseUrl(env.REFLEKTOR_APP_URL || settings.reflektorAppUrl || DEFAULT_APP, "app"),
    appUrlSet: Boolean(env.REFLEKTOR_APP_URL || settings.reflektorAppUrl),
  };
}

// The API URL as the reader typed it in Settings, ready for settings.json: empty for Reflektor's own (so it follows
// the default), otherwise the base URL. Throws bad_url for one that is not a URL, or plain http off this machine.
export function settingApiUrl(value: string): string {
  const typed = value.trim();
  if (!typed) return "";
  const url = baseUrl(typed, "API");
  return url === DEFAULT_API ? "" : url;
}

// The app a sign-in page belongs to: Reflektor sends its own (<app>/device), so a self-hosted one links to itself
// without a second setting. null when the page is not a usable base URL.
function appOf(start: DeviceStart): string | null {
  try {
    return baseUrl(new URL(start.verificationUri ?? start.verificationUriComplete).origin, "app");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the login file

const isUser = (u: unknown): u is ReflektorUser => Boolean(u) && typeof (u as ReflektorUser).email === "string" && typeof (u as ReflektorUser).id === "string";

// The saved login, or null when there is none or it cannot be used (unreadable, a field missing, a URL changed by
// hand to one that is not https).
export function readLogin(file = LOGIN_FILE): ReflektorLogin | null {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<ReflektorLogin>;
    if (typeof saved.token !== "string" || !saved.token || !isUser(saved.user) || typeof saved.apiUrl !== "string") return null;
    return {
      apiUrl: baseUrl(saved.apiUrl, "API"),
      appUrl: typeof saved.appUrl === "string" ? baseUrl(saved.appUrl, "app") : DEFAULT_APP,
      token: saved.token,
      user: { id: saved.user.id, email: saved.user.email, name: saved.user.name ?? null },
      savedAt: typeof saved.savedAt === "string" ? saved.savedAt : "",
      organizations: saved.organizations && typeof saved.organizations === "object" ? saved.organizations : {},
    };
  } catch {
    return null;
  }
}

// Written beside the file and moved into place, readable by the user only (mode 0600; Windows has no such modes).
export function saveLogin(login: ReflektorLogin, file = LOGIN_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  // The mode above applies only when the file is new; a temp file left behind by a crash keeps its own.
  chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
}

// Logout: deletes the login file and nothing else. True when there was one.
export function forgetLogin(file = LOGIN_FILE): boolean {
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return existed;
}

// "github.com/acme/payments", the way the platform names a repository. Lower case: the platform matches ignoring case.
export const repositoryKey = (repo: Repository) => `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();

// The repository a bundle is about, or null when its remote does not name a host and an owner.
export function repositoryOf(bundle: Bundle): Repository | null {
  const { host, owner, name } = bundle.diff.repo;
  return host && owner && name ? { host, owner, name } : null;
}

// Keeps the organization picked for a repository in the login file, for the next publish.
export function rememberOrganization(repo: Repository, slug: string, file = LOGIN_FILE): void {
  const login = readLogin(file);
  if (!login) return;
  saveLogin({ ...login, organizations: { ...login.organizations, [repositoryKey(repo)]: slug } }, file);
}

// ------------------------------------------------------------------ calls

type CallOptions = { method?: "GET" | "POST"; token?: string; json?: unknown; zip?: boolean; timeoutMs?: number };

// Retry-After in seconds or as a date, in milliseconds from now.
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(1000, ms) : undefined;
}

// zod's issues, or whatever the API lists, in a few words each.
const issuesText = (issues: unknown): string => {
  if (!Array.isArray(issues) || !issues.length) return "";
  const shown = issues.slice(0, 3).map((i) => {
    const issue = i as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
    return [path, typeof issue.message === "string" ? issue.message : JSON.stringify(i)].filter(Boolean).join(": ");
  });
  return ` (${shown.join("; ")}${issues.length > 3 ? `; ${issues.length - 3} more` : ""})`;
};

// The error for an answer that is not 2xx, in the reader's words.
function refusal(res: Response, data: unknown): ReflektorError {
  const body = (data ?? {}) as { error?: unknown; organizations?: unknown; issues?: unknown; message?: unknown; minimum?: unknown };
  const code = typeof body.error === "string" ? body.error : res.status === 401 ? "unauthorized" : "http";
  const status = res.status;
  if (res.status === 401) return failure("unauthorized", status, "Reflektor no longer accepts this machine's login: it was revoked or has expired. Sign in again.");
  switch (code) {
    case "repository_not_approved":
      return failure(code, status, "No organization of yours approves this repository on Reflektor, so nothing was stored. An admin of your organization has to approve it first.");
    case "not_a_member":
      return failure(code, status, "You are not a member of that organization on Reflektor.");
    case "organization_required": {
      const organizations = Array.isArray(body.organizations) ? (body.organizations as Organization[]) : [];
      return failure(code, status, `Several of your organizations approve this repository. Choose one: ${organizations.map((o) => o.slug).join(", ")}.`, { organizations });
    }
    case "invalid_bundle":
      return failure(code, status, `Reflektor refused the report as not valid${issuesText(body.issues)}. Updating pr-report may help.`);
    case "update_required": {
      const minimum = typeof body.minimum === "string" ? body.minimum : undefined;
      return failure(code, status, `Reflektor takes reports from pr-report ${minimum ?? "a newer version"} or newer, and this is ${skillVersion()}. Update pr-report from the report's menu, then publish again.`, { minimum });
    }
    case "too_large":
      return failure(code, status, "The report is too large for Reflektor (25 MB at most, gzipped).");
    case "rate_limited": {
      const ms = retryAfter(res);
      return failure(code, status, `Reflektor asks to slow down${ms ? `: try again in ${Math.ceil(ms / 60_000)} min` : ""}.`, { retryAfterMs: ms });
    }
    case "expired_token":
      return failure(code, status, "The sign-in code expired before it was approved. Sign in again.");
    case "access_denied":
      return failure(code, status, "The sign-in was denied in the browser.");
    default:
      return failure(code, status, `Reflektor answered HTTP ${status}${typeof body.error === "string" ? ` (${body.error})` : ""}.`, { retryAfterMs: retryAfter(res) });
  }
}

async function call<T>(apiUrl: string, path: string, { method = "GET", token, json, zip = false, timeoutMs = CALL_MS }: CallOptions = {}): Promise<T> {
  const text = json === undefined ? undefined : JSON.stringify(json);
  const body = text !== undefined && zip ? await gzipped(text) : text;
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "pr-report",
        // Reflektor refuses a publish from a pr-report older than its minimum (426 update_required).
        "x-pr-report-version": skillVersion(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(zip ? { "content-encoding": "gzip" } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = (e as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : ((e as { cause?: Error }).cause?.message ?? (e as Error).message);
    throw failure("network", null, `Could not reach Reflektor at ${apiUrl}: ${reason}.`);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw refusal(res, data);
  return data as T;
}

// ------------------------------------------------------------------ login

// Step 1 of the device flow: a code for the user to approve in the browser. `clientName` is what the approval page
// shows: "pr-report on ada-mbp".
export async function startDeviceLogin(config: ReflektorConfig, clientName = `pr-report on ${hostname().split(".")[0]}`): Promise<DeviceStart> {
  const start = await call<DeviceStart>(config.apiUrl, "/auth/device", { method: "POST", json: { clientName } });
  if (!start || typeof start.deviceCode !== "string" || typeof start.userCode !== "string" || typeof start.verificationUriComplete !== "string")
    throw failure("bad_answer", null, "Reflektor did not answer with a sign-in code.");
  // The page to approve on is opened in the browser and shown as a link, so it must be a web page.
  for (const page of [start.verificationUriComplete, start.verificationUri ?? start.verificationUriComplete])
    if (!/^https?:\/\//i.test(page)) throw failure("bad_answer", null, `Reflektor named a sign-in page that is not a web address: ${page}`);
  return start;
}

// Step 2: asks every `interval` seconds until the user approved (the login, not saved yet), denied, or the code
// expired (both throw). `slow_down` adds 5 seconds, as the device flow asks. A missed answer or two (a network blip)
// is waited out; three in a row end it. `sleep` and `now` are for the check suites.
export async function finishDeviceLogin(
  config: ReflektorConfig,
  start: DeviceStart,
  { sleep = sleepFor, now = Date.now }: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ReflektorLogin> {
  const seconds = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);
  let interval = seconds(start.interval, DEVICE_INTERVAL_S);
  const deadline = now() + seconds(start.expiresIn, DEVICE_EXPIRES_S) * 1000;
  for (let missed = 0; ; ) {
    await sleep(interval * 1000);
    try {
      const answer = await call<{ accessToken?: unknown; user?: unknown }>(config.apiUrl, "/auth/device/token", { method: "POST", json: { deviceCode: start.deviceCode } });
      if (typeof answer?.accessToken !== "string" || !isUser(answer.user)) throw failure("bad_answer", null, "Reflektor approved the sign-in but sent no token.");
      const user = answer.user;
      const appUrl = config.appUrlSet === false ? (appOf(start) ?? config.appUrl) : config.appUrl;
      return { apiUrl: config.apiUrl, appUrl, token: answer.accessToken, user: { id: user.id, email: user.email, name: user.name ?? null }, savedAt: new Date(now()).toISOString(), organizations: {} };
    } catch (e) {
      const code = (e as ReflektorError).code;
      if (code === "slow_down") interval += 5;
      else if (code === "network" && ++missed < 3) continue;
      else if (code !== "authorization_pending") throw e;
      missed = 0;
      if (now() >= deadline) throw failure("expired_token", null, "The sign-in code expired before it was approved. Sign in again.");
    }
  }
}

// The account the saved token belongs to, asked of the API.
export async function whoami(login: ReflektorLogin): Promise<ReflektorUser> {
  const answer = await call<ReflektorUser | { user?: ReflektorUser }>(login.apiUrl, "/auth/me", { token: login.token });
  const user = (answer as { user?: ReflektorUser })?.user ?? answer;
  if (!isUser(user)) throw failure("bad_answer", null, "Reflektor did not say whose login this is.");
  return { id: user.id, email: user.email, name: user.name ?? null };
}

// ------------------------------------------------------------------ publish

// Which of the user's organizations approve the repository. Only the host, owner and name leave the machine.
export async function preflight(login: ReflektorLogin, repository: Repository): Promise<Organization[]> {
  const answer = await call<{ organizations?: unknown }>(login.apiUrl, "/reports/preflight", { method: "POST", token: login.token, json: { repository } });
  if (!Array.isArray(answer?.organizations)) throw failure("bad_answer", null, "Reflektor's preflight did not list organizations.");
  return (answer.organizations as Organization[]).filter((o) => o && typeof o.slug === "string").map((o) => ({ slug: o.slug, name: typeof o.name === "string" ? o.name : o.slug }));
}

// Paths on this machine (the repo's folder, its git dir, the checks file) mean nothing to Reflektor and say where the
// user keeps their code, so they are blanked before the bundle leaves.
// Screenshots go with the report unless the repo's .pr-report.json says "screenshots": { "upload": false }: then the
// report goes without them, so nothing on the page points at pictures Reflektor does not have.
const sendsScreenshots = (bundle: Bundle) => Boolean(bundle.screenshots) && bundle.diff.config?.screenshots?.upload !== false;

// Bundles built before build.mjs dropped it still carry the local path of the report a review was sent on.
const withoutReportPath = (review: Review): Review => {
  const { report: _report, ...rest } = review as Review & { report?: string };
  return rest;
};

export const withoutLocalPaths = (bundle: Bundle): Bundle => ({
  ...bundle,
  diff: { ...bundle.diff, repo: { ...bundle.diff.repo, root: "", gitDir: "" } },
  projectChecks: bundle.projectChecks ? { ...bundle.projectChecks, file: "" } : null,
  previousReview: bundle.previousReview ? withoutReportPath(bundle.previousReview) : null,
  screenshots:
    sendsScreenshots(bundle) && bundle.screenshots
      ? { ...bundle.screenshots, file: "", sets: bundle.screenshots.sets.map((set) => ({ ...set, shots: set.shots.map(({ src: _src, ...shot }) => shot) })) }
      : null,
});

// Sends the pictures of a published round that Reflektor does not have yet, from the folder of screenshots.json.
// Never throws: a picture that did not go up only leaves its spot empty on the page.
async function uploadScreenshots(login: ReflektorLogin, bundle: Bundle, reportId: string): Promise<ScreenshotsUploaded | undefined> {
  if (!sendsScreenshots(bundle) || !bundle.screenshots?.file) return undefined;
  const folder = dirname(bundle.screenshots.file);
  const names = [...new Set(bundle.screenshots.sets.flatMap((set) => set.shots.flatMap((shot) => (shot.status === "taken" && shot.file ? [shot.file.split("/").pop()!] : []))))];
  if (!names.length) return undefined;
  const base = `/reports/${encodeURIComponent(reportId)}/screenshots`;
  let sent = 0;
  let failed = 0;
  let error: string | null = null;
  try {
    const { missing } = await call<{ missing: string[] }>(login.apiUrl, `${base}/missing`, { method: "POST", token: login.token, json: { names } });
    for (const name of Array.isArray(missing) ? missing : []) {
      const file = join(folder, "shots", name);
      try {
        if (!existsSync(file)) throw new Error(`${name} is not on this machine any more`);
        const res = await fetch(`${login.apiUrl}${base}/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${login.token}`, "content-type": "image/png", "user-agent": "pr-report", "x-pr-report-version": skillVersion() },
          body: readFileSync(file),
          signal: AbortSignal.timeout(UPLOAD_MS),
        });
        if (!res.ok) throw refusal(res, await res.json().catch(() => null));
        sent++;
      } catch (e) {
        failed++;
        error ??= (e as Error).message;
      }
    }
  } catch (e) {
    failed = names.length;
    error = (e as Error).message;
  }
  return { sent, failed, error };
}

// The bundle as the viewer gets it, without local paths, gzipped. `organization` may be left out when one organization
// approves the repo.
export async function upload(login: ReflektorLogin, bundle: Bundle, organization?: string | null): Promise<Uploaded> {
  const sent = withoutLocalPaths(bundle);
  const answer = await call<Uploaded>(login.apiUrl, "/reports", { method: "POST", token: login.token, json: organization ? { organization, bundle: sent } : { bundle: sent }, zip: true, timeoutMs: UPLOAD_MS });
  if (typeof answer?.report?.url !== "string" || typeof answer.round !== "number") throw failure("bad_answer", null, "Reflektor stored the report but did not say where.");
  return { report: { id: String(answer.report.id), url: answer.report.url }, round: answer.round, created: answer.created !== false };
}

const sameSlug = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

// One publish: a draft never goes, nothing goes before the preflight names an organization, and with several the one
// asked for, else the one saved for the repo, else none (organization_required, with the list to choose from).
// Never throws.
export async function publishBundle(login: ReflektorLogin, bundle: Bundle, { organization = null }: { organization?: string | null } = {}): Promise<PublishOutcome> {
  if (bundle.draft) return { ok: false, reason: "draft", message: "This round is still a draft: the agent has not finished the report." };
  const repository = repositoryOf(bundle);
  if (!repository) return { ok: false, reason: "no_remote", message: "This report was made without a remote that names the repository's host and owner, so Reflektor cannot tell which repository it is. Add the remote, then make the report again: the repository is read when the report is made, so adding the remote alone is not enough." };
  const key = repositoryKey(repository);
  try {
    const organizations = await preflight(login, repository);
    const list = organizations.map((o) => o.slug).join(", ");
    if (!organizations.length)
      return { ok: false, reason: "not_approved", message: `No organization of yours approves ${key} on Reflektor, so nothing was uploaded. An admin of your organization has to approve the repository first.` };
    const saved = login.organizations?.[key];
    const chosen = organization
      ? organizations.find((o) => sameSlug(o.slug, organization))
      : organizations.length === 1
        ? organizations[0]
        : organizations.find((o) => sameSlug(o.slug, saved));
    if (organization && !chosen)
      return { ok: false, reason: "unknown_organization", message: `${organization} is not one of your organizations that approve ${key}. Those are: ${list}.`, organizations };
    if (!chosen) return { ok: false, reason: "organization_required", message: `Several of your organizations approve ${key}. Choose one: ${list}.`, organizations };
    const uploaded = await upload(login, bundle, chosen.slug);
    const screenshots = await uploadScreenshots(login, bundle, uploaded.report.id);
    return { ok: true, organization: chosen.slug, ...uploaded, ...(screenshots ? { screenshots } : {}) };
  } catch (e) {
    const error = e as ReflektorError;
    return { ok: false, reason: error.code ?? "http", message: error.message, organizations: error.organizations, retryAfterMs: error.retryAfterMs, minimum: error.minimum };
  }
}
