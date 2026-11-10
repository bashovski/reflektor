#!/usr/bin/env node
// Browser check: drives a whole review through the real page in headless Chrome, with a private
// daemon, the fake books repo and review.mjs playing the agent. Covers what scripts/check.mjs cannot
// see from the API: the first-run setup page, the draft page, comments and Send, the warning when no
// session listens, the plan, progress, the next round with its "since round 1" view, the warning about
// changed code, and the offer of the setup to a browser that skipped it.
//
// Uses the installed Google Chrome (or PR_REPORT_CHROME=<path>), so no browser is downloaded.
// Usage: node scripts/browser-check.mjs [--headed]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBash } from "../skill/scripts/repo.mjs";
import { githubPr, startGithubStub } from "./github-stub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, "viewer/package.json"))("playwright-core");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-browser-"));
const repo = join(tmp, "books");
const data = join(repo, ".git/pr-report/feat-books");
// GitHub is a local stub: the fake repo's remote is on github.com, so the daemon would otherwise ask the real API.
// GH_CONFIG_DIR points at nothing, so gh has no login and the user menu shows the repo's git identity.
const github = await startGithubStub();
const env = {
  ...process.env,
  PR_REPORT_HOME: join(tmp, "home"),
  PR_REPORT_PORT: String(4900 + Math.floor(Math.random() * 400)),
  PR_REPORT_DRIFT_SECONDS: "1",
  PR_REPORT_GITHUB_API: github.url,
  PR_REPORT_GITHUB_TOKEN: "stub-token",
  PR_REPORT_PR_POLL_SECONDS: "1",
  GH_CONFIG_DIR: join(tmp, "gh-config"),
  // The suite's calls say which agent they are, so the page words are the same wherever the suite runs.
  PR_REPORT_AGENT: "claude-code",
};

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
const script = (name, ...args) => run("node", [join(root, "skill/scripts", name), ...args]);
const review = (...args) => script("review.mjs", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failed = true;
};
// Waits for a locator to show, and fails with a readable message when it does not.
const expectVisible = async (locator, what, timeout = 10_000) => {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    fail(`not shown: ${what}`);
    return false;
  }
};

const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ...(process.env.PR_REPORT_CHROME ? { executablePath: process.env.PR_REPORT_CHROME } : { channel: "chrome" }),
});
const errors = [];

try {
  run(gitBash() ?? "bash", [join(root, "fixtures/make-books-repo.sh"), repo]);
  script("collect.mjs", "--repo", repo, "--no-fetch");
  writeFileSync(join(data, "report.json"), readFileSync(join(root, "samples/report.json")));

  // 0. First-run setup, the way the installer opens it: before any review exists. Enter moves on,
  // the picks are saved for this browser, and the inbox greets the reader when setup ends. The rest
  // of the check then runs in dark mode with GitHub Dark, a theme the renderer has to load first.
  review("setup", "--no-open");
  const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8"));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/setup`);
  await expectVisible(page.getByRole("heading", { name: "Welcome to pr-report" }), "the setup page");
  await page.keyboard.press("Enter");
  await expectVisible(page.getByRole("heading", { name: "Your tools" }), "the tools step");
  await expectVisible(page.getByText(/Logged in|not logged in|Not installed/).first(), "what the daemon found out about gh and glab", 15_000);
  await page.keyboard.press("Enter");
  await expectVisible(page.getByRole("heading", { name: "Light or dark?" }), "the theme step");
  await page.getByRole("button", { name: "Dark Always dark" }).click();
  await page.keyboard.press("Enter");
  await expectVisible(page.getByRole("heading", { name: "Pick a code theme" }), "the code theme step");
  await page.getByRole("option", { name: "GitHub Dark", exact: true }).click();
  await expectVisible(page.getByRole("option", { name: "GitHub Dark", exact: true, selected: true }), "the picked code theme");
  await page.keyboard.press("Enter");
  await expectVisible(page.getByRole("heading", { name: "You're all set" }), "the inbox greeting after setup");
  const saved = await page.evaluate(() => ["pr-report:setup", "pr-report:theme", "pr-report:code-theme-dark"].map((k) => localStorage.getItem(k)));
  if (!saved[0] || saved[1] !== '"dark"' || saved[2] !== '"github-dark"') fail(`setup did not save its choices: ${saved.join(" ")}`);

  // 1. The draft opens first: the facts, with sending held back.
  const draftOut = script("build.mjs", "--diff", join(data, "diff.json"), "--draft").match(/Wrote (\S+)/)[1];
  const id = review("open", "--report", draftOut).match(/Review id: (\S+)/)[1];
  await page.goto(`http://127.0.0.1:${port}/r/${id}`);
  await expectVisible(page.getByText("Claude is reading the change and writing the notes"), "the draft notice");
  if (!(await page.getByRole("button", { name: "Claude is writing the notes" }).isDisabled())) fail("Send is not held back on a draft");

  // 2. The real report replaces the draft in the same tab.
  const realOut = script("build.mjs", "--diff", join(data, "diff.json"), "--report", join(data, "report.json")).match(/Wrote (\S+)/)[1];
  review("open", "--report", realOut);
  await expectVisible(page.getByRole("heading", { name: /Save and list books in the library/ }), "the report after the draft");
  await expectVisible(page.getByRole("button", { name: "LGTM" }), "Send once the report is ready");

  // The page names the agent on the other side, and follows when another one picks the review up. One the table
  // does not know is shown under the name made from its id.
  await expectVisible(page.getByText(/were written by Claude and may be wrong/), "the agent's name in the page");
  review("resume", "--id", id, "--agent", "zed-agent");
  await expectVisible(page.getByText(/were written by Zed Agent and may be wrong/), "the name of another agent that picked the review up");
  review("resume", "--id", id);
  await expectVisible(page.getByText(/were written by Claude and may be wrong/), "the first agent's name once it calls again");

  // The owner menu links to the owner's page, the inbox, and a new pull request filled in from the report.
  await page.getByRole("button", { name: /acme-labs/ }).click();
  await expectVisible(page.getByRole("menuitem", { name: /Open Owner Page/ }), "the owner page link");
  const inboxLink = page.getByRole("menuitem", { name: /View All Reports for acme-labs/ });
  if ((await expectVisible(inboxLink, "the inbox link for the owner")) && (await inboxLink.getAttribute("href")) !== "/?owner=acme-labs") fail("the inbox link does not ask for the owner's reviews only");
  const newPr = page.getByRole("menuitem", { name: /Open Pull Request.*feat\/books is not pushed yet/ });
  if (await expectVisible(newPr, "the new pull request link with the not-pushed warning")) {
    const href = await newPr.getAttribute("href");
    if (!href?.startsWith("https://github.com/acme-labs/library/compare/main...feat/books?expand=1&title=")) fail(`the new pull request link does not point at GitHub's compare form: ${href}`);
  }
  await page.keyboard.press("Escape");

  // The user menu: who is reading (the repo's git identity here), help, the cache, and the daemon's status.
  await page.getByRole("button", { name: "Your account and the daemon" }).click();
  await expectVisible(page.getByText("Sample Dev"), "the reader's name in the user menu");
  await expectVisible(page.getByText(/from git config/), "where the identity came from");
  await expectVisible(page.getByText(/Daemon up/), "the daemon status");
  await page.getByRole("menuitem", { name: "Help" }).click();
  await expectVisible(page.getByRole("heading", { name: "How to review" }), "the help dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Your account and the daemon" }).click();
  await page.getByRole("menuitem", { name: "Purge daemon cache" }).click();
  await page.getByRole("button", { name: "Purge", exact: true }).click();
  await expectVisible(page.getByText(/Removed \d+ cached/), "the purge result");
  await page.getByRole("button", { name: "Close" }).click();

  // 3. Comments: one on the whole change, and "Fix this" on a risk.
  await page.getByRole("button", { name: "General comment" }).click();
  await page.getByPlaceholder("A comment about the whole change").fill("Rename slug to handle");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.locator("#changes").getByRole("button", { name: /Backend changes/ }).click();
  await page.getByRole("button", { name: "Fix this" }).first().click();
  await expectVisible(page.getByRole("button", { name: "Send 2 to Claude" }), "Send with two comments");

  // 4. Sent with no session listening: after 15 seconds the page says how to pick it up.
  // Ctrl+Enter sends, the same as the button.
  await page.keyboard.press("Control+Enter");
  await expectVisible(page.getByText("Sent round 1 with 2 comments"), "the sent state");
  await expectVisible(page.getByText("No Claude session is listening for this review."), "the warning that no session listens", 25_000);
  // The inbox row names the review's own agent; its groups and filters keep the neutral words, since they span agents.
  const sentInbox = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  if (!sentInbox.includes(">Sent to Claude</span>") || !sentInbox.includes('"Sent to the agent"')) fail("the inbox does not name the agent a review was sent to");
  await expectVisible(page.getByRole("button", { name: "/pr-report resume" }), "the resume command");

  // 5. The agent picks it up, posts a plan, the reviewer approves it in the page, progress shows.
  if (!review("resume", "--id", id).includes("was sent with 2 comments")) fail("resume did not hand over the sent review");
  const sent = JSON.parse(readFileSync(join(data, "review-1.json"), "utf8")).comments.map((c) => c.id);
  writeFileSync(join(tmp, "plan.json"), JSON.stringify({ steps: [{ comments: sent, where: "book.service.ts:19", kind: "fix", action: "Rename the column and catch the duplicate" }] }));
  review("plan", "--id", id, "--file", join(tmp, "plan.json"));
  await expectVisible(page.getByText("Rename the column and catch the duplicate"), "the plan");
  await page.getByRole("button", { name: "Go ahead" }).click();
  if (!review("wait", "--id", id).includes("approved the plan")) fail("approving in the page did not reach the agent");
  review("status", "--id", id, "--comment", sent[0], "--status", "fixed", "--text", "Renamed");
  await expectVisible(page.getByText("Claude is working: 1 of 2 done."), "progress");
  review("status", "--id", id, "--comment", sent[1], "--status", "fixed", "--text", "Caught");

  // 6. The fix, then round 2 with the whole branch and the change since round 1.
  const service = join(repo, "apps/api/src/books/book.service.ts");
  writeFileSync(service, `// handle, not slug\n${readFileSync(service, "utf8")}`);
  script("collect.mjs", "--repo", repo, "--no-fetch", "--update");
  const round2 = script("build.mjs", "--diff", join(data, "diff.json"), "--report", join(data, "report.json")).match(/Wrote (\S+)/)[1];
  review("open", "--report", round2);
  await expectVisible(page.getByText("Round 2 is ready."), "the round 2 banner");
  await page.getByRole("button", { name: "Show round 2" }).click();
  await expectVisible(page.getByRole("radio", { name: /Since round 1/ }), "the since round 1 view");
  if ((await page.locator("#changes section").count()) !== 1) fail("the since round 1 view shows more than the one section that changed");
  await page.getByRole("radio", { name: /Whole branch/ }).click();
  await page.locator("#changes").getByRole("button", { name: /Backend changes/ }).click();
  await expectVisible(page.getByText("Changed since round 1"), "the changed-since mark in the whole-branch view");

  // 7. Code edited after round 2 was built: the page says so and can ask for an update.
  const api = join(repo, "apps/web/src/api/books.ts");
  writeFileSync(api, `${readFileSync(api, "utf8")}// edited after the report\n`);
  await expectVisible(page.getByText(/1 file changed after this report was built: books\.ts/), "the changed-code warning", 15_000);
  await page.getByRole("button", { name: "Ask Claude to update the report" }).click();
  if (!review("wait", "--id", id).includes("asked for an updated report")) fail("the update request did not reach the agent");

  // 7b. A pull request opened on GitHub after the report was built shows up in the header within a
  // poll; merged, the page says so at the top, the before-merge items are done, and the warning
  // about changed code goes, since the code is meant to move on now.
  github.set([githubPr(7, "open")]);
  await expectVisible(page.getByRole("link", { name: /PR #7.*Open/ }), "the open pull request pill in the header", 15_000);
  await page.getByRole("button", { name: /acme-labs/ }).click();
  await expectVisible(page.getByRole("menuitem", { name: /View Pull Request/ }), "the pull request in the owner menu");
  if (await page.getByRole("menuitem", { name: /Open Pull Request/ }).count()) fail("the owner menu still offers a new pull request while one is open");
  await page.keyboard.press("Escape");
  github.set([githubPr(7, "closed", new Date().toISOString())]);
  await expectVisible(page.getByText(/Pull request #7 was merged into main on/), "the merged banner", 15_000);
  await expectVisible(page.getByRole("link", { name: /PR #7.*Merged/ }), "the merged pull request pill in the header");
  await expectVisible(page.getByText("Merged, so these are done."), "the before-merge items shown as done");
  try {
    await page.getByText(/changed after this report was built/).first().waitFor({ state: "hidden", timeout: 5000 });
  } catch {
    fail("the changed-code warning stays after the merge");
  }
  let title = "";
  for (let i = 0; i < 20 && !/merged/i.test(title); i++) {
    await sleep(200);
    title = await page.title();
  }
  if (!/merged/i.test(title)) fail(`the tab title does not say the pull request is merged: ${title}`);

  // 8. The inbox shows one owner's reviews when asked, groups by owner by default, and remembers another grouping after a reload.
  await page.goto(`http://127.0.0.1:${port}/?owner=someone-else`);
  await expectVisible(page.getByText("Owner: someone-else"), "the owner filter");
  await expectVisible(page.getByText("0 of 1 reviews"), "an owner filter that hides the other owners' reviews");
  await page.goto(`http://127.0.0.1:${port}/`);
  await expectVisible(page.getByRole("heading", { name: /acme-labs/ }), "the owner heading in the inbox");
  await page.getByRole("button", { name: /^Group/ }).click();
  await page.getByRole("radio", { name: "Status" }).check();
  await page.reload();
  // The review's pull request is merged, so the status group is "Merged", not "Waiting on you".
  await expectVisible(page.getByRole("heading", { name: /^Merged/ }), "the status grouping after a reload");
  if (!(await page.locator(".row .pr[data-state=MERGED]").count())) fail("the inbox row has no chip for the merged pull request");
  // Search sits in the filter menu and forgives typos.
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("textbox", { name: "Search reviews" }).fill("zzzz");
  await expectVisible(page.getByText("No reviews match these filters."), "the empty search result");
  await page.getByRole("textbox", { name: "Search reviews" }).fill("libary");
  await expectVisible(page.getByRole("heading", { name: /^Merged/ }), "a fuzzy search match");

  // 9. A browser that skipped the setup is offered it once, above a report and on the inbox.
  await page.evaluate(() => localStorage.removeItem("pr-report:setup"));
  await page.goto(`http://127.0.0.1:${port}/r/${id}`);
  await expectVisible(page.getByRole("link", { name: "Set up pr-report" }), "the setup offer above a report");
  await page.getByRole("button", { name: "Not now" }).click();
  await page.goto(`http://127.0.0.1:${port}/`);
  await expectVisible(page.getByRole("heading", { name: "PR reports" }), "the inbox again");
  if (await page.locator("#setup-hint").isVisible()) fail("the inbox offers the setup again after Not now");

  const unexpected = errors.filter((e) => !/favicon/.test(e));
  if (unexpected.length) fail(`errors in the page:\n${unexpected.join("\n")}`);
  console.log(
    "browser: setup page, draft, report, comments, send, no-listener warning, resume, plan, progress, round 2 views, owner menu, user menu, agent name, changed-code warning, pull request opened and merged, inbox grouping and search, and the setup offer all worked",
  );
} catch (e) {
  fail(e.stderr?.toString() || e.stack || e.message);
} finally {
  await browser.close();
  try {
    review("stop");
  } catch {
    // Already stopped.
  }
  github.close();
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else console.log("browser check passed");
