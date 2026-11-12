// Data contract for the PR report.
// diff.json   = DiffData, written by scripts/collect.mjs (facts from git, never edited by hand)
// report.json = Report, written by the agent (judgment: words, grouping, flows)
// The viewer receives Bundle, produced by scripts/build.mjs after validation.
//
// This file is the only list of allowed values. build.mjs reads every union of string literals
// below (Tag, Target, SectionKind, ...) and rejects report.json values outside them.
// Adding a value here also needs a label and color in viewer/src/lib/meta.ts (TypeScript will flag it).

// ------------------------------------------------------------------ diff.json

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  generated: boolean;
  uncommitted: boolean;
  untracked: boolean;
  // From .pr-report.json "targets" globs; null when no glob matches or there is no config.
  target: Target | null;
  oldContent: string | null;
  newContent: string | null;
  changedLines: { added: number[]; removed: number[] };
};

export type BaseSource = "argument" | "open-pr" | "config" | "default-branch" | "guess";
export type Forge = "github" | "gitlab" | "bitbucket";
export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type Commit = { sha: string; short: string; subject: string; author: string; date: string };

export type CoverageData = {
  // stale = the coverage file is older than the newest change, so its numbers may not match the code.
  sources: { file: string; format: string; modified: string; stale: boolean }[];
  files: Record<string, { covered: number[]; uncovered: number[] }>;
  covered: number;
  uncovered: number;
  percent: number | null;
};

export type FindingKind = "secret" | "migration";

export type Severity = "high" | "medium" | "low";

// A safety check hit from collect.mjs. `preview` shows a masked secret, never the full value.
export type Finding = { kind: FindingKind; rule: string; severity: Severity; path: string; line: number | null; message: string; preview?: string };

export type CheckStatus = "passed" | "failed" | "timeout";

// One project check run by checks.mjs. outputTail holds the last lines of stdout and stderr.
export type ProjectCheck = { name: string; command: string; status: CheckStatus; exitCode: number | null; durationMs: number; outputTail: string };

// running: checks are still going, `pending` lists the ones without a result yet.
// stopped: the run's process ended before its last check (killed or crashed).
export type ChecksRunStatus = "running" | "done" | "stopped";

// One run of checks.mjs, read from its checks.json. The daemon streams it to open pages as it changes.
export type ChecksRun = {
  status: ChecksRunStatus;
  startedAt: string | null;
  ranAt: string | null;
  headSha: string;
  results: ProjectCheck[];
  pending: string[];
};

// The repo owner's picture: a data URL from github.com or gitlab.com, else initials on a color.
export type RepoAvatar = { image: string | null; initials: string; color: string };

export type DiffData = {
  version: 1;
  generatedAt: string;
  // avatar is missing in reports collected before avatars existed.
  repo: {
    host: string | null;
    owner: string | null;
    name: string;
    root: string;
    gitDir: string;
    // The repo and its owner on the web, when the remote names both. `forge` picks the pull request URL layout.
    web?: { url: string; ownerUrl: string; forge: Forge | null } | null;
    avatar?: RepoAvatar;
  };
  branch: {
    head: string;
    headSha: string;
    // Commit holding the reported working tree (uncommitted and untracked files included). Equals headSha with --no-uncommitted.
    snapshot: string;
    base: string;
    baseRef: string;
    baseSource: BaseSource;
    mergeBase: string;
    // The branch's pull request on GitHub as of this build, in any state. Reports from before `state`
    // count as open. The review daemon follows the pull request live from here (see viewer/src/lib/pr.ts).
    pr: { number: number; url: string; title: string; state?: PrState } | null;
    // The branch on the remote as of the last fetch or push, and commits not pushed yet. Null when it is not on the remote.
    upstream?: { ref: string; ahead: number } | null;
  };
  scope: { mode: "branch" | "since" | "files" | "since+files"; from: string; includesUncommitted: boolean; files: string[] | null };
  // collect.mjs --update: what changed since the round the reviewer sent. `from` is the snapshot
  // that round showed; each file's oldContent is its content then (null when added since).
  sinceRound?: { round: number; from: string; files: DiffFile[] };
  commits: Commit[];
  stats: { files: number; additions: number; deletions: number; uncommittedFiles: number };
  files: DiffFile[];
  coverage: CoverageData | null;
  findings: Finding[];
  config: RepoConfig | null;
  warnings: string[];
};

// Optional .pr-report.json in the repo root. Globs follow .gitignore style: a pattern without "/" matches at any depth.
export type RepoConfig = {
  base?: string;
  targets?: Partial<Record<Target, string[]>>;
  generated?: string[];
  coverage?: { command?: string; files?: string[] };
  // The project's own checks, run by checks.mjs. `when` limits one to changes in those paths.
  checks?: { name: string; command: string; timeout?: number; when?: string[] }[];
  // Commands run at fixed points of a report (skill/scripts/hooks.mjs): one command or a list, in the repo's root.
  hooks?: Partial<Record<HookName, string | string[]>>;
};

export type HookName = "preRun" | "postRun" | "onApproved";

// ------------------------------------------------------------------ report.json
// Text fields (highlights, notes, line notes, flow details, questions, before-merge items, test gaps)
// accept a small Markdown subset: **bold**, `code`, "- " bullets, "1. " numbered items. See style-guide.md.
// title and summary are plain text.

export type Tag = "HOTFIX" | "SECURITY" | "FEATURE" | "FIX" | "PERF" | "REFACTOR" | "CHORE";

export type Target = "backend" | "frontend" | "database" | "infrastructure" | "cicd" | "misc";

export type SectionKind =
  | "database"
  | "infrastructure"
  | "config"
  | "dependencies"
  | "backend"
  | "frontend"
  | "cicd"
  | "tests"
  | "refactors"
  | "generated"
  | "other";

export type ReviewLevel = "must" | "skim" | "skip";

export type HighlightKind = "behavior" | "risk" | "contract" | "decision" | "gap" | "affected";

// Points at a line. `side: "old"` means the line number is in the old version of the file.
export type Ref = { path: string; line?: number; side?: "new" | "old" };

export type Highlight = {
  kind: HighlightKind;
  text: string;
  ref?: Ref;
  // Suggested fix, one sentence or a short list. Give one for every risk and gap.
  // The page shows it with a "Fix this" button, so a click means "do exactly this".
  fix?: string;
};

export type LineNote = { line: number; side?: "new" | "old"; text: string };

export type SectionFile = {
  path: string;
  // 1 to 4 short sentences shown above the code: what changed and why.
  note: string;
  lineNotes?: LineNote[];
};

export type Section = {
  kind: SectionKind;
  title?: string;
  review: ReviewLevel;
  // One line: why this review level.
  reason: string;
  highlights: Highlight[];
  questions: string[];
  files: SectionFile[];
};

export type BeforeMergeKind = "migration" | "env" | "deploy-order" | "flag" | "breaking" | "manual";

export type BeforeMerge = { kind: BeforeMergeKind; text: string; ref?: Ref };

export type FlowDetailKind = "check" | "rule" | "effect" | "error" | "note";

export type StepStatus = "new" | "changed" | "existing";

export type FlowStep = {
  // Free text, any stack: "UI", "Hook", "HTTP", "Controller", "Service", "Repo", "DB", "Queue", "Job", "CLI"...
  layer: string;
  // The function, route, table or component name. The build checks it appears in the file.
  symbol: string;
  ref?: Ref;
  status: StepStatus;
  // `fix` works like Highlight.fix; give one for every "error" detail.
  details?: { kind: FlowDetailKind; text: string; fix?: string }[];
};

export type Flow = {
  id: string;
  title: string;
  // What starts this flow, in plain words: "User fills the form on /library and clicks Save".
  trigger: string;
  steps: FlowStep[];
};

export type SchemaStatus = "new" | "changed" | "removed" | "existing";

export type SchemaColumn = {
  name: string;
  type: string;
  status: SchemaStatus;
  key?: "pk" | "unique";
  // "table.column" this column points to. enforced: false = no real foreign key in the database.
  references?: string;
  enforced?: boolean;
  note?: string;
};

// A table touched by the change, or an existing table that a new relation points to (only the columns involved).
export type SchemaTable = { name: string; status: SchemaStatus; columns: SchemaColumn[]; ref?: Ref };

export type ContractKind = "type" | "interface" | "enum" | "constant";

export type ContractStatus = "new" | "changed" | "removed";

export type MemberChange = "added" | "removed" | "changed";

// A field of a type or interface, a value of an enum, or a member of a union type.
// `type` is as written in the code; `was` is the old type of a changed member.
export type ContractMember = { name: string; change: MemberChange; type?: string; was?: string };

// A type, interface, enum or exported constant that the change adds, changes or removes.
// `ref` points at its definition in the new code, or in the old code when removed.
// `members` lists what changed (all of them for a new one). `value` and `was` are a constant's new and old values.
// `generated` is set by the build when the file is generated (OpenAPI, GraphQL or ORM output).
export type Contract = {
  name: string;
  kind: ContractKind;
  status: ContractStatus;
  ref: Ref;
  note?: string;
  members?: ContractMember[];
  value?: string;
  was?: string;
  generated?: boolean;
};

export type PlanStatus = "done" | "partial" | "missing" | "extra";

// One item of the session's plan, checked against the diff. "extra" = a change the plan did not ask for.
export type PlanItem = { text: string; status: PlanStatus; ref?: Ref; note?: string };

export type Report = {
  version: 1;
  tag: Tag;
  title: string;
  summary: string;
  targets: Target[];
  reviewMinutes: number;
  beforeMerge: BeforeMerge[];
  flows: Flow[];
  sections: Section[];
  testing?: { gaps: string[] };
  // Tables changed by this PR, drawn as a diagram. Leave out when the database is not touched.
  schema?: { tables: SchemaTable[] };
  // Types, interfaces, enums and exported constants the change adds, changes or removes.
  contracts?: Contract[];
  // Did the change do what this session planned? Leave out when there was no plan.
  plan?: { source: string; items: PlanItem[] };
  // Answers to the previous review round. Add one reply per comment in that round's review file.
  review?: { round: number; replies: Reply[] };
  // Set by collect.mjs --update: the snapshot the line numbers in this file refer to. Leave it as is.
  refsAt?: string;
};

// ------------------------------------------------------------------ review (comments from the report page)
// The page saves comments as you type. Sending the review writes review-<round>.json next to report.json.

export type CommentKind = "fix" | "question" | "nit" | "accepted" | "decision";

export type CommentTarget =
  // `round` is set on an old-side comment made while the page showed the changes since that round:
  // the line numbers are then in the file as that round showed it, not in the base version.
  | { type: "line"; path: string; side: "new" | "old"; start: number; end: number; code: string; round?: number }
  | { type: "file"; path: string }
  | { type: "highlight"; section: SectionKind; index: number; kind: HighlightKind; text: string; fix?: string }
  | { type: "question"; section: SectionKind; index: number; text: string }
  | { type: "flow-detail"; flow: string; step: number; detail: number; symbol: string; text: string; fix?: string }
  | { type: "before-merge"; index: number; text: string }
  | { type: "plan-item"; index: number; status: PlanStatus; text: string }
  | { type: "report" };

export type ReviewComment = {
  id: string;
  target: CommentTarget;
  // What the reviewer typed. Empty for a one-click "Fix this" (do the suggested fix) or "It's fine".
  text: string;
  // Set when a button decided it ("Fix this", "It's fine", an answer to a question). Otherwise the agent infers it.
  kind?: CommentKind;
  createdAt: string;
};

// A question asked while reviewing, answered live by the agent through review.mjs.
export type LiveQuestion = {
  id: string;
  target: CommentTarget;
  text: string;
  askedAt: string;
  answer: { text: string; ref?: Ref; answeredAt: string } | null;
};

export type Review = {
  version: 1;
  round: number;
  branch: string;
  headSha: string;
  snapshot: string;
  submittedAt: string;
  comments: ReviewComment[];
  // Live questions from this round, with their answers.
  questions?: LiveQuestion[];
};

export type ReplyStatus = "fixed" | "answered" | "wontfix" | "noted";

// The agent's answer to one comment, shown at the top of the next report.
export type Reply = { commentId: string; status: ReplyStatus; text: string; ref?: Ref };

// ------------------------------------------------------------------ bundle (viewer input)

export type FlowStepChecked = FlowStep & { verified: boolean };

// The coding agent on the other side of a review, in the words the page shows. `name` is the assistant
// ("Send to Claude"), `product` the program the user types into ("In Claude Code, run ..."), `resume` what
// they type there to pick a review up. Worked out by scripts/agent.mjs from skill/agents.json.
export type AgentInfo = { id: string | null; name: string; product: string; resume: string | null; version: string | null };

// Who is reading a page, as the daemon's /api/me works it out (scripts/identity.mts): the forge account when its CLI
// is logged in, else the repo's git identity. The reader's menu draws it, on a report and in the inbox.
export type Identity = {
  source: "gh" | "glab" | "git" | "none";
  login: string | null;
  name: string | null;
  email: string | null;
  url: string | null;
  host: string | null;
  avatar: RepoAvatar;
};

// What the daemon hands the inbox page's script (viewer/src/inbox/inbox.ts), in a JSON block before it: the status
// labels and colors, the order of the types, when each listed review last changed, the page token, what /api/me is
// asked about, and the daemon for the status line in the reader's menu.
export type InboxData = {
  phases: Record<string, [label: string, color: string]>;
  tags: string[];
  folderIcon: string;
  shown: Record<string, string>;
  token: string;
  me: { host: string; forge: string; root: string };
  daemon: { version: string; node: string; startedAt: string };
};

export type Bundle = {
  diff: DiffData;
  report: Omit<Report, "flows"> & { flows: (Omit<Flow, "steps"> & { steps: FlowStepChecked[] })[] };
  // Contents of files referenced by flows that did not change (for "open file").
  contextFiles: Record<string, string>;
  // The review round that report.review answers, so the page can show each comment next to its reply.
  previousReview: Review | null;
  // Next review round number; the page stamps it on the comments it saves.
  round: number;
  // File type icons (from atom-material-icons): SVG per icon key, and the key for each file path. Null when not installed.
  fileIcons: { icons: Record<string, string>; byPath: Record<string, string> } | null;
  // Results from checks.mjs. `stale` = code changed after the checks ran.
  // `file` is the checks.json the daemon watches for live updates.
  projectChecks: (ChecksRun & { stale: boolean; file: string }) | null;
  // Pull request title and Markdown body, written from this report. Null when the report covers only
  // part of the branch (--since or --files), so it cannot describe the pull request.
  prDescription: { title: string; body: string } | null;
  // Built with --draft before the agent's report was ready: the page shows the facts and holds back sending.
  draft?: boolean;
  // The agent that built the report; null or missing when the build could not tell.
  agent?: AgentInfo | null;
  warnings: string[];
  builtAt: string;
};
