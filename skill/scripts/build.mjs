#!/usr/bin/env node
// Checks report.json against diff.json, then writes the report data (one JSON file per round) that the
// review daemon serves. --html also writes one self-contained HTML file to keep or send.
// Problems that Claude should fix are printed as "warning:" lines; hard errors exit with code 1.
//
// Usage:
//   node build.mjs --diff diff.json --report report.json [--out report-r1.json]
//                  [--html report.html] [--viewer viewer.html] [--open]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readChecksRun } from "./checks-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Allowed values live only in schema/types.ts: every `export type X = "a" | "b";` union is read here.
function readUnions(file) {
  const unions = {};
  for (const m of readFileSync(file, "utf8").matchAll(/export type (\w+) =([^;{]+);/g)) {
    const members = m[2].split("|").map((s) => s.trim()).filter(Boolean);
    if (members.length && members.every((s) => /^"[^"]*"$/.test(s))) unions[m[1]] = members.map((s) => s.slice(1, -1));
  }
  return unions;
}
const unions = readUnions(join(here, "../schema/types.ts"));
const union = (name) => {
  if (!unions[name]) throw new Error(`schema/types.ts has no string union named ${name}`);
  return unions[name];
};
const TAGS = union("Tag");
const TARGETS = union("Target");
const SECTIONS = union("SectionKind");
const REVIEW = union("ReviewLevel");
const HIGHLIGHTS = union("HighlightKind");
const BEFORE_MERGE = union("BeforeMergeKind");
const STEP_STATUS = union("StepStatus");
const DETAIL_KINDS = union("FlowDetailKind");
const REPLY_STATUS = union("ReplyStatus");
const PLAN_STATUS = union("PlanStatus");
const SCHEMA_STATUS = union("SchemaStatus");
const CONTRACT_KINDS = union("ContractKind");
const CONTRACT_STATUS = union("ContractStatus");
const MEMBER_CHANGES = union("MemberChange");

function parseArgs(argv) {
  const args = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--diff") args.diff = next();
    else if (a === "--report") args.report = next();
    else if (a === "--out") args.out = next();
    else if (a === "--html") args.html = next();
    else if (a === "--viewer") args.viewer = next();
    else if (a === "--checks") args.checks = next();
    else if (a === "--open") args.open = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.diff || !args.report) throw new Error("--diff and --report are required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const diff = JSON.parse(readFileSync(args.diff, "utf8"));
const report = JSON.parse(readFileSync(args.report, "utf8"));

const errors = [];
const warnings = [];
// Warnings from collect.mjs (for example a stale coverage file) need no report change; they print as notes.
const notes = [...(diff.warnings ?? [])];

const filesByPath = new Map(diff.files.map((f) => [f.path, f]));
const lineCount = (text) => (text == null ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

function readRepoFile(path) {
  const full = join(diff.repo.root, path);
  if (existsSync(full)) return readFileSync(full, "utf8");
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { cwd: diff.repo.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function contentFor(path, side = "new") {
  const f = filesByPath.get(path);
  if (f) return side === "old" ? f.oldContent : f.newContent ?? f.oldContent;
  return readRepoFile(path);
}

function oneOf(value, allowed, where) {
  if (!allowed.includes(value)) errors.push(`${where}: "${value}" is not one of ${allowed.join(", ")}`);
}

function checkRef(ref, where, { mustBeInDiff = false } = {}) {
  if (!ref) return ref;
  if (typeof ref.path !== "string") {
    warnings.push(`${where}: ref has no path, dropped`);
    return undefined;
  }
  const inDiff = filesByPath.has(ref.path);
  if (mustBeInDiff && !inDiff) {
    warnings.push(`${where}: ${ref.path} is not in the diff, link dropped`);
    return undefined;
  }
  const content = contentFor(ref.path, ref.side);
  if (content == null) {
    warnings.push(`${where}: ${ref.path} does not exist, link dropped`);
    return undefined;
  }
  if (ref.line != null && (ref.line < 1 || ref.line > lineCount(content))) {
    warnings.push(`${where}: line ${ref.line} is outside ${ref.path} (${lineCount(content)} lines), line dropped`);
    return { ...ref, line: undefined };
  }
  return ref;
}

// ------------------------------------------------------------------ header

oneOf(report.tag, TAGS, "tag");
for (const t of report.targets ?? []) oneOf(t, TARGETS, "targets");
if (!report.title) errors.push("title is empty");
if (report.title?.length > 100) warnings.push(`title is ${report.title.length} characters; aim for under 90`);
const sentences = (report.summary ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
if (sentences.length > 2) warnings.push(`summary has ${sentences.length} sentences; the limit is 2`);

report.beforeMerge = (report.beforeMerge ?? []).map((b, i) => {
  oneOf(b.kind, BEFORE_MERGE, `beforeMerge[${i}].kind`);
  return { ...b, ref: checkRef(b.ref, `beforeMerge[${i}]`) };
});

// ------------------------------------------------------------------ sections

const assigned = new Map();
report.sections = (report.sections ?? []).map((s, si) => {
  const where = `sections[${si}] (${s.kind})`;
  oneOf(s.kind, SECTIONS, `${where}.kind`);
  oneOf(s.review, REVIEW, `${where}.review`);
  const highlights = (s.highlights ?? []).map((h, hi) => {
    oneOf(h.kind, HIGHLIGHTS, `${where}.highlights[${hi}].kind`);
    if ((h.kind === "risk" || h.kind === "gap") && !h.fix) warnings.push(`${where}.highlights[${hi}]: ${h.kind} has no suggested fix`);
    return { ...h, ref: checkRef(h.ref, `${where}.highlights[${hi}]`) };
  });
  if (highlights.length > 5) warnings.push(`${where}: ${highlights.length} highlights; keep it to 5`);

  const files = (s.files ?? []).filter((f) => {
    if (!filesByPath.has(f.path)) {
      warnings.push(`${where}: ${f.path} is not in the diff, removed`);
      return false;
    }
    if (assigned.has(f.path)) {
      warnings.push(`${where}: ${f.path} is already in section "${assigned.get(f.path)}", removed here`);
      return false;
    }
    assigned.set(f.path, s.kind);
    return true;
  }).map((f) => {
    const diffFile = filesByPath.get(f.path);
    const lineNotes = (f.lineNotes ?? []).filter((n) => {
      const content = n.side === "old" ? diffFile.oldContent : diffFile.newContent;
      const ok = content != null && n.line >= 1 && n.line <= lineCount(content);
      if (!ok) warnings.push(`${where}: line note at ${f.path}:${n.line} is outside the file, removed`);
      return ok;
    });
    return { ...f, lineNotes };
  });

  return { ...s, highlights, questions: s.questions ?? [], files };
});

const unassigned = diff.files.filter((f) => !assigned.has(f.path));
if (unassigned.length) {
  warnings.push(`${unassigned.length} changed file(s) not in any section, added to "Other": ${unassigned.map((f) => f.path).join(", ")}`);
  report.sections.push({
    kind: "other",
    review: "skim",
    reason: "The report did not describe these files.",
    highlights: [],
    questions: [],
    files: unassigned.map((f) => ({ path: f.path, note: "" })),
  });
}

// ------------------------------------------------------------------ plan

if (report.plan) {
  report.plan.items = (report.plan.items ?? []).map((item, i) => {
    oneOf(item.status, PLAN_STATUS, `plan.items[${i}].status`);
    if (item.status === "done" && !item.ref) warnings.push(`plan.items[${i}]: done, but no ref shows where`);
    return { ...item, ref: checkRef(item.ref, `plan.items[${i}]`) };
  });
}

// ------------------------------------------------------------------ schema

if (report.schema) {
  const changedText = diff.files.map((f) => `${f.oldContent ?? ""}\n${f.newContent ?? ""}`).join("\n");
  const names = new Set((report.schema.tables ?? []).map((t) => t.name));
  report.schema.tables = (report.schema.tables ?? []).map((t, ti) => {
    const where = `schema.tables[${ti}] (${t.name})`;
    oneOf(t.status, SCHEMA_STATUS, `${where}.status`);
    if (t.status !== "existing" && !changedText.includes(t.name)) warnings.push(`${where}: "${t.name}" does not appear in any changed file`);
    for (const c of t.columns ?? []) {
      oneOf(c.status, SCHEMA_STATUS, `${where}.columns.${c.name}.status`);
      const target = c.references?.split(".")[0];
      if (target && !names.has(target)) warnings.push(`${where}.${c.name}: references ${c.references}, but table ${target} is not in the diagram`);
    }
    return { ...t, ref: checkRef(t.ref, where) };
  });
}

// ------------------------------------------------------------------ safety findings
// Every high or medium finding from collect.mjs must show up in a highlight or a before-merge item.

const mentioned = [...report.sections.flatMap((s) => s.highlights.map((h) => h.ref)), ...report.beforeMerge.map((b) => b.ref)].filter(Boolean);
for (const f of diff.findings ?? []) {
  if (f.severity === "low") continue;
  const covered = mentioned.some((r) => r.path === f.path && (f.line == null || r.line == null || Math.abs(r.line - f.line) <= 3));
  if (!covered) warnings.push(`safety check "${f.rule}" at ${f.path}${f.line ? `:${f.line}` : ""} is not in any highlight or before-merge item`);
}

// ------------------------------------------------------------------ flows

const contextFiles = {};
const lastIdentifier = (symbol) => {
  const tokens = symbol.match(/\/[\w/:{}.-]+|[A-Za-z_$][\w$-]*/g) ?? [];
  return tokens.at(-1) ?? symbol;
};

report.flows = (report.flows ?? []).map((flow, fi) => ({
  ...flow,
  steps: (flow.steps ?? []).map((step, si) => {
    const where = `flows[${fi}].steps[${si}] (${step.symbol})`;
    oneOf(step.status, STEP_STATUS, `${where}.status`);
    for (const d of step.details ?? []) {
      oneOf(d.kind, DETAIL_KINDS, `${where}.details.kind`);
      if (d.kind === "error" && !d.fix) warnings.push(`${where}: error detail has no suggested fix`);
    }
    const ref = checkRef(step.ref, where);
    let verified = false;
    if (ref) {
      const content = contentFor(ref.path);
      verified = content != null && content.includes(lastIdentifier(step.symbol));
      if (!filesByPath.has(ref.path) && content != null) contextFiles[ref.path] = content;
      if (step.status !== "existing" && !filesByPath.has(ref.path)) {
        warnings.push(`${where}: marked "${step.status}" but ${ref.path} did not change`);
      }
    }
    if (!verified) warnings.push(`${where}: could not find "${lastIdentifier(step.symbol)}" in ${ref?.path ?? "(no file)"}; shown as unverified`);
    return { ...step, ref, verified };
  }),
}));

// ------------------------------------------------------------------ types and contracts
// Every name must be in the changed file its ref points at: the new version, or the old one for
// anything removed. A misspelled or made-up name is dropped with a warning.

const hasWord = (text, word) =>
  text != null && word !== "" && new RegExp(`(^|[^\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w$])`).test(text);

report.contracts = (report.contracts ?? []).flatMap((c, ci) => {
  const where = `contracts[${ci}] (${c.name})`;
  oneOf(c.kind, CONTRACT_KINDS, `${where}.kind`);
  oneOf(c.status, CONTRACT_STATUS, `${where}.status`);
  const side = c.status === "removed" ? "old" : "new";
  const ref = c.ref && checkRef({ ...c.ref, side }, where, { mustBeInDiff: true });
  const name = lastIdentifier(c.name ?? "");
  if (!ref || !hasWord(contentFor(ref.path, side), name)) {
    warnings.push(`${where}: could not find "${name}" in ${ref?.path ?? "(no file)"}, removed`);
    return [];
  }
  const members = (c.members ?? []).filter((m) => {
    oneOf(m.change, MEMBER_CHANGES, `${where}.members.${m.name}.change`);
    const found = hasWord(contentFor(ref.path, m.change === "removed" ? "old" : "new"), lastIdentifier(m.name ?? ""));
    if (!found) warnings.push(`${where}: member "${m.name}" is not in ${ref.path}, removed`);
    return found;
  });
  if (members.length > 20) warnings.push(`${where}: ${members.length} members; list the 20 that matter most`);
  return [{ ...c, ref, members, generated: Boolean(c.generated || filesByPath.get(ref.path)?.generated) }];
});
if (report.contracts.length > 25) warnings.push(`contracts: ${report.contracts.length}; list the 25 that matter most`);

// ------------------------------------------------------------------ output

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

// ------------------------------------------------------------------ file icons
// assets/file-icons.json comes from atom-material-icons (MIT). Only the icons this report's files use are embedded.

function pickFileIcons(paths) {
  const file = join(here, "../assets/file-icons.json");
  if (!existsSync(file)) return null;
  const set = JSON.parse(readFileSync(file, "utf8"));
  // Angular naming rules (*.service.ts, *.component.ts) would mislabel files in other projects.
  const angular = existsSync(join(diff.repo.root, "angular.json"));
  const rules = set.rules.filter(([, icon]) => angular || !icon.startsWith("angular")).map(([pattern, icon, color]) => [new RegExp(pattern), icon, color]);
  const result = { icons: {}, byPath: {} };
  for (const path of paths) {
    const [, icon, color] = rules.find(([re]) => re.test(basename(path))) ?? [null, "default", null];
    const key = color ? `${icon}-${color}` : icon;
    if (!result.icons[key]) {
      let svg = set.icons[icon] ?? set.icons.default;
      // Icons without a fill of their own take the rule's color, as in the editor theme.
      if (color && !/^<svg[^>]*\sfill=/.test(svg)) svg = svg.replace(/^<svg/, `<svg fill="#${color}"`);
      result.icons[key] = svg;
    }
    result.byPath[path] = key;
  }
  return result;
}

const fileIcons = pickFileIcons([...diff.files.map((f) => f.path), ...Object.keys(contextFiles)]);


// ------------------------------------------------------------------ review rounds
// The daemon writes review-<round>.json next to the report. report.review answers one of them.

const reviewDir = args.out ? dirname(resolve(args.out)) : join(diff.repo.gitDir, "pr-report");
const rounds = existsSync(reviewDir)
  ? readdirSync(reviewDir)
      .map((f) => f.match(/^review-(\d+)\.json$/)?.[1])
      .filter(Boolean)
      .map(Number)
  : [];
const round = rounds.length ? Math.max(...rounds) + 1 : 1;

let previousReview = null;
if (report.review) {
  const file = join(reviewDir, `review-${report.review.round}.json`);
  if (!existsSync(file)) {
    warnings.push(`review: ${file} does not exist, so the replies cannot be shown`);
  } else {
    previousReview = JSON.parse(readFileSync(file, "utf8"));
    const ids = new Set(previousReview.comments.map((c) => c.id));
    report.review.replies = (report.review.replies ?? []).filter((r, i) => {
      oneOf(r.status, REPLY_STATUS, `review.replies[${i}].status`);
      if (!ids.has(r.commentId)) warnings.push(`review.replies[${i}]: no comment with id ${r.commentId} in round ${report.review.round}, removed`);
      return ids.has(r.commentId);
    }).map((r, i) => ({ ...r, ref: checkRef(r.ref, `review.replies[${i}]`) }));
    const answered = new Set(report.review.replies.map((r) => r.commentId));
    for (const c of previousReview.comments) if (!answered.has(c.id)) warnings.push(`review: comment ${c.id} from round ${report.review.round} has no reply`);
  }
}
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

// ------------------------------------------------------------------ project checks
// checks.json from checks.mjs, next to diff.json unless --checks says otherwise.

// The checks may still be running: the report is built anyway, and the daemon streams their
// progress from `file` to the page.
function loadProjectChecks() {
  const file = resolve(args.checks ?? join(dirname(resolve(args.diff)), "checks.json"));
  const run = readChecksRun(file);
  if (!run) return null;
  if (run.status === "stopped") notes.push("Project checks stopped before they finished; the report shows the ones that did.");
  const since = Date.parse(run.ranAt ?? run.startedAt);
  // Stale when a commit or an uncommitted file is newer than the run.
  const newestCommit = Math.max(0, ...diff.commits.map((c) => Date.parse(c.date)));
  const newestFile = Math.max(
    0,
    ...diff.files.filter((f) => f.uncommitted).map((f) => {
      const full = join(diff.repo.root, f.path);
      return existsSync(full) ? statSync(full).mtimeMs : 0;
    }),
  );
  const stale = run.headSha !== diff.branch.headSha || newestCommit > since || newestFile > since;
  if (stale) notes.push("Project checks ran before the latest code change; run checks.mjs again for current results.");
  return { ...run, stale, file };
}

const projectChecks = loadProjectChecks();

// ------------------------------------------------------------------ PR description
// Markdown for the pull request, built only from the checked report. Written next to the HTML and embedded in it.

const TARGET_LABELS = { backend: "Backend", frontend: "Frontend", database: "Database", infrastructure: "Infrastructure", cicd: "CI/CD", misc: "Misc" };
const SECTION_LABELS = {
  database: "Database", infrastructure: "Infrastructure", config: "Config", dependencies: "Dependencies", backend: "Backend",
  frontend: "Frontend", cicd: "CI/CD", tests: "Tests", refactors: "Refactors", generated: "Generated", other: "Other",
};
// Report text may hold short lists; a PR bullet needs one line.
const oneLine = (text) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/^([-*•]|\d+[.)])\s+/, ""))
    .filter(Boolean)
    .join("; ")
    .replace(/:;/g, ":");
const refText = (ref) => (ref ? ` (\`${ref.path}${ref.line ? `:${ref.line}` : ""}\`)` : "");

function prDescription() {
  const title = `[${report.tag}] ${report.title}`;
  const lines = ["## Summary", "", report.summary, ""];
  const areas = report.targets.map((t) => TARGET_LABELS[t]).join(", ");
  lines.push(`**Areas:** ${areas} · **Size:** ${diff.stats.files} files, +${diff.stats.additions} −${diff.stats.deletions} · **Review time:** about ${report.reviewMinutes} min`, "");

  lines.push("## What changed", "");
  for (const s of report.sections) {
    if (s.kind === "generated") continue;
    const main = s.highlights.find((h) => h.kind === "behavior") ?? s.highlights[0];
    const count = `${s.files.length} ${s.files.length === 1 ? "file" : "files"}`;
    lines.push(`- **${s.title ?? SECTION_LABELS[s.kind]}** (${count}): ${oneLine(main?.text ?? s.reason)}`);
  }
  lines.push("");

  if (report.beforeMerge.length) {
    lines.push("## Before you merge", "");
    for (const b of report.beforeMerge) lines.push(`- [ ] ${oneLine(b.text)}`);
    lines.push("");
  }

  const risks = [
    ...report.sections.flatMap((s) => s.highlights.filter((h) => h.kind === "risk").map((h) => `${oneLine(h.text)}${refText(h.ref)}`)),
    ...report.flows.flatMap((f) => f.steps.flatMap((st) => (st.details ?? []).filter((d) => d.kind === "error").map((d) => `${oneLine(d.text)}${refText(st.ref)}`))),
  ];
  if (risks.length) {
    lines.push("## Risks", "");
    for (const r of [...new Set(risks)].slice(0, 5)) lines.push(`- ${r}`);
    lines.push("");
  }

  if (report.contracts.length) {
    lines.push("## Types and contracts", "");
    for (const c of report.contracts) {
      const value =
        c.kind !== "constant" ? "" : c.was && c.value ? `: \`${c.was}\` → \`${c.value}\`` : c.value ? `: \`${c.value}\`` : c.was ? `: was \`${c.was}\`` : "";
      lines.push(`- **${c.name}** (${c.kind}, ${c.status}${c.generated ? ", generated" : ""})${value}${c.note ? `. ${oneLine(c.note)}` : ""}${refText(c.ref)}`);
    }
    lines.push("");
  }

  if (report.plan?.items.length) {
    const planned = report.plan.items.filter((i) => i.status !== "extra");
    const done = planned.filter((i) => i.status === "done").length;
    lines.push("## Plan", "", `${done} of ${planned.length} planned items done (${report.plan.source}).`);
    for (const i of report.plan.items.filter((i) => i.status !== "done")) {
      const label = { partial: "Partly done", missing: "Not done", extra: "Not in the plan" }[i.status];
      lines.push(`- ${label}: ${oneLine(i.text)}${i.note ? `. ${oneLine(i.note)}` : ""}`);
    }
    lines.push("");
  }

  if (projectChecks?.results.length || projectChecks?.pending.length) {
    lines.push("## Checks", "");
    for (const c of projectChecks.results) lines.push(`- ${c.status === "passed" ? "Passed" : c.status === "failed" ? "**Failed**" : "**Timed out**"}: ${c.name} (\`${c.command}\`)`);
    const unfinished = projectChecks.status === "stopped" ? "Did not finish" : "Still running";
    for (const name of projectChecks.pending) lines.push(`- ${unfinished}: ${name}`);
    lines.push("");
  }

  const gaps = report.testing?.gaps ?? [];
  if (diff.coverage?.percent != null || gaps.length) {
    lines.push("## Testing", "");
    if (diff.coverage?.percent != null) lines.push(`- Tests run ${diff.coverage.percent}% of the new lines (${diff.coverage.covered} of ${diff.coverage.covered + diff.coverage.uncovered}).`);
    for (const g of gaps.slice(0, 3)) lines.push(`- Not tested: ${oneLine(g)}`);
    lines.push("");
  }

  if (previousReview && report.review) {
    const fixed = report.review.replies.filter((r) => r.status === "fixed").length;
    lines.push("## Review", "", `Review round ${report.review.round}: ${previousReview.comments.length} comments, ${fixed} fixed.`, "");
  }

  lines.push("<sub>Written from a pr-report review report.</sub>");
  return { title, body: lines.join("\n") };
}

// A report about part of the branch (--since, --files) cannot describe the pull request, so the
// description from the last whole-branch build stays.
const partial = diff.scope.mode !== "branch";
const prText = partial ? null : prDescription();

// The round is part of the name: fixes are often uncommitted, so two rounds can share a commit.
const slug = diff.branch.head.replace(/[^\w.-]+/g, "-");
const out = resolve(args.out ?? join(diff.repo.gitDir, "pr-report", `${slug}-${diff.branch.headSha.slice(0, 7)}-r${round}.json`));

const bundle = {
  diff,
  report,
  contextFiles,
  previousReview,
  round,
  fileIcons,
  projectChecks,
  prDescription: prText,
  warnings: [...notes, ...warnings],
  builtAt: new Date().toISOString(),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle));

// The standalone page: the viewer with this report's data inside, for keeping or sending.
const htmlOut = args.html ? resolve(args.html) : args.open ? out.replace(/\.json$/, ".html") : null;
if (htmlOut) {
  // Installed skill ships assets/viewer.html; the source checkout uses the Vite build output.
  const viewerPath = args.viewer ?? [join(here, "../assets/viewer.html"), join(here, "../../viewer/dist/standalone/index.html")].find(existsSync);
  if (!viewerPath) throw new Error("Viewer not found. Build it with `pnpm build` or pass --viewer.");
  const html = readFileSync(viewerPath, "utf8");
  if (!html.includes("__PR_REPORT_DATA__")) throw new Error(`${viewerPath} has no data placeholder`);
  // The page's base title (see viewer/src/lib/tab.ts), so the tab is right while the page loads.
  const title = `${diff.branch.head} · ${diff.repo.name}${round > 1 ? ` · round ${round}` : ""}`.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
  mkdirSync(dirname(htmlOut), { recursive: true });
  writeFileSync(
    htmlOut,
    html
      .replace("<title>PR report</title>", () => `<title>${title}</title>`)
      .replace("__PR_REPORT_DATA__", () => JSON.stringify(bundle).replace(/</g, "\\u003c")),
  );
}
const prFile = join(dirname(out), "pr-description.md");
if (prText) writeFileSync(prFile, `${prText.title}\n\n${prText.body}\n`);
else notes.push(`PR description not updated: this report covers only part of the branch (${diff.scope.mode}). Build a whole-branch report before opening the PR.`);

const state = join(diff.repo.gitDir, "pr-report", "last.json");
mkdirSync(dirname(state), { recursive: true });
writeFileSync(state, JSON.stringify({ headSha: diff.branch.headSha, snapshot: diff.branch.snapshot, round, report: out, builtAt: bundle.builtAt }, null, 2));
// Keep the snapshot commits from being garbage-collected: the last one for --since last, and one per
// round, so the next round can show what changed since this one. Refs are invisible to branches and tags.
if (diff.branch.snapshot) {
  try {
    execFileSync("git", ["update-ref", "refs/pr-report/last", diff.branch.snapshot], { cwd: diff.repo.root, stdio: "ignore" });
    execFileSync("git", ["update-ref", `refs/pr-report/rounds/${slug}/r${round}`, diff.branch.snapshot], { cwd: diff.repo.root, stdio: "ignore" });
  } catch {
    warnings.push("Could not save refs/pr-report/last; --since last may fail after git garbage collection.");
  }
}

const steps = report.flows.flatMap((f) => f.steps);
console.log(`Wrote ${out}`);
if (htmlOut) console.log(`Standalone page: ${htmlOut}`);
console.log(
  `${report.sections.length} sections, ${diff.files.length} files, ${steps.filter((st) => st.verified).length}/${steps.length} flow steps verified, ${warnings.length} warnings`,
);
console.log("Saved this run for --since last (refs/pr-report/last)");
if (prText) console.log(`PR description: ${prFile} (first line is the title)`);
if (diff.sinceRound) console.log(`Round ${round} shows the whole branch; ${diff.sinceRound.files.length} files changed since round ${diff.sinceRound.round}.`);
for (const n of notes) console.log(`note: ${n}`);
// Printed only: the page shows the checks live, so this would be out of date there.
if (projectChecks?.status === "running") console.log("note: Project checks are still running; the review page shows each result when it is ready.");
for (const w of warnings) console.log(`warning: ${w}`);

if (args.open) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [htmlOut], { detached: true, stdio: "ignore" }).unref();
}
