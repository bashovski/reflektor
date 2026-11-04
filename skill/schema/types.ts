// Data contract for the PR report.
// diff.json   = DiffData, written by scripts/collect.mjs (facts from git, never edited by hand)
// report.json = Report, written by Claude (judgment: words, grouping, flows)
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

export type Commit = { sha: string; short: string; subject: string; author: string; date: string };

export type CoverageData = {
  // stale = the coverage file is older than the newest change, so its numbers may not match the code.
  sources: { file: string; format: string; modified: string; stale: boolean }[];
  files: Record<string, { covered: number[]; uncovered: number[] }>;
  covered: number;
  uncovered: number;
  percent: number | null;
};

export type DiffData = {
  version: 1;
  generatedAt: string;
  repo: { host: string | null; owner: string | null; name: string; root: string; gitDir: string };
  branch: {
    head: string;
    headSha: string;
    // Commit holding the reported working tree (uncommitted and untracked files included). Equals headSha with --no-uncommitted.
    snapshot: string;
    base: string;
    baseRef: string;
    baseSource: BaseSource;
    mergeBase: string;
    pr: { number: number; url: string; title: string } | null;
  };
  scope: { mode: "branch" | "since" | "files" | "since+files"; from: string; includesUncommitted: boolean; files: string[] | null };
  commits: Commit[];
  stats: { files: number; additions: number; deletions: number; uncommittedFiles: number };
  files: DiffFile[];
  coverage: CoverageData | null;
  config: RepoConfig | null;
  warnings: string[];
};

// Optional .pr-report.json in the repo root. Globs follow .gitignore style: a pattern without "/" matches at any depth.
export type RepoConfig = {
  base?: string;
  targets?: Partial<Record<Target, string[]>>;
  generated?: string[];
  coverage?: { command?: string; files?: string[] };
};

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

export type Highlight = { kind: HighlightKind; text: string; ref?: Ref };

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
  details?: { kind: FlowDetailKind; text: string }[];
};

export type Flow = {
  id: string;
  title: string;
  // What starts this flow, in plain words: "User fills the form on /library and clicks Save".
  trigger: string;
  steps: FlowStep[];
};

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
};

// ------------------------------------------------------------------ bundle (viewer input)

export type FlowStepChecked = FlowStep & { verified: boolean };

export type Bundle = {
  diff: DiffData;
  report: Omit<Report, "flows"> & { flows: (Omit<Flow, "steps"> & { steps: FlowStepChecked[] })[] };
  // Contents of files referenced by flows that did not change (for "open file").
  contextFiles: Record<string, string>;
  warnings: string[];
  builtAt: string;
};
