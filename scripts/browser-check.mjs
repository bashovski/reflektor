#!/usr/bin/env node
// Browser check: drives a whole review through the real page in headless Chrome, with a private
// daemon, the fake books repo and review.mjs playing the agent. Covers what scripts/check.mjs cannot
// see from the API: the draft page, comments and Send, the warning when no session listens, the plan,
// progress, the next round with its "since round 1" view, and the warning about changed code.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, "viewer/package.json"))("playwright-core");
const tmp = mkdtempSync(join(tmpdir(), "pr-report-browser-"));
const repo = join(tmp, "books");
const data = join(repo, ".git/pr-report/feat-books");
const env = { ...process.env, PR_REPORT_HOME: join(tmp, "home"), PR_REPORT_PORT: String(4900 + Math.floor(Math.random() * 400)), PR_REPORT_DRIFT_SECONDS: "1" };

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

  // 1. The draft opens first: the facts, with sending held back.
  const draftOut = script("build.mjs", "--diff", join(data, "diff.json"), "--draft").match(/Wrote (\S+)/)[1];
  const id = review("open", "--report", draftOut).match(/Review id: (\S+)/)[1];
  const { port } = JSON.parse(readFileSync(join(env.PR_REPORT_HOME, "daemon.json"), "utf8"));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/r/${id}`);
  await expectVisible(page.getByText("Claude is reading the change and writing the notes"), "the draft notice");
  if (!(await page.getByRole("button", { name: "Claude is writing the notes" }).isDisabled())) fail("Send is not held back on a draft");

  // 2. The real report replaces the draft in the same tab.
  const realOut = script("build.mjs", "--diff", join(data, "diff.json"), "--report", join(data, "report.json")).match(/Wrote (\S+)/)[1];
  review("open", "--report", realOut);
  await expectVisible(page.getByRole("heading", { name: /Save and list books in the library/ }), "the report after the draft");
  await expectVisible(page.getByRole("button", { name: "Looks good, tell Claude" }), "Send once the report is ready");

  // 3. Comments: one on the whole change, and "Fix this" on a risk.
  await page.getByRole("button", { name: "General comment" }).click();
  await page.getByPlaceholder("A comment about the whole change").fill("Rename slug to handle");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.locator("#changes").getByRole("button", { name: /Backend changes/ }).click();
  await page.getByRole("button", { name: "Fix this" }).first().click();
  await expectVisible(page.getByRole("button", { name: "Send 2 to Claude" }), "Send with two comments");

  // 4. Sent with no session listening: after 15 seconds the page says how to pick it up.
  await page.getByRole("button", { name: "Send 2 to Claude" }).click();
  await expectVisible(page.getByText("Sent round 1 with 2 comments"), "the sent state");
  await expectVisible(page.getByText("No Claude session is listening for this review."), "the warning that no session listens", 25_000);
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

  // 8. The inbox groups by owner by default, and remembers another grouping after a reload.
  await page.goto(`http://127.0.0.1:${port}/`);
  await expectVisible(page.getByRole("heading", { name: /acme-labs/ }), "the owner heading in the inbox");
  await page.getByRole("button", { name: /^Group/ }).click();
  await page.getByRole("radio", { name: "Status" }).check();
  await page.reload();
  await expectVisible(page.getByRole("heading", { name: /Waiting on you/ }), "the status grouping after a reload");
  // Search sits in the filter menu and forgives typos.
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("textbox", { name: "Search reviews" }).fill("zzzz");
  await expectVisible(page.getByText("No reviews match these filters."), "the empty search result");
  await page.getByRole("textbox", { name: "Search reviews" }).fill("libary");
  await expectVisible(page.getByRole("heading", { name: /Waiting on you/ }), "a fuzzy search match");

  const unexpected = errors.filter((e) => !/favicon/.test(e));
  if (unexpected.length) fail(`errors in the page:\n${unexpected.join("\n")}`);
  console.log("browser: draft, report, comments, send, no-listener warning, resume, plan, progress, round 2 views, changed-code warning, inbox grouping and search all worked");
} catch (e) {
  fail(e.stderr?.toString() || e.stack || e.message);
} finally {
  await browser.close();
  try {
    review("stop");
  } catch {
    // Already stopped.
  }
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else console.log("browser check passed");
