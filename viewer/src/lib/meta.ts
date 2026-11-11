import {
  Activity,
  AppWindow,
  ArrowRight,
  Blocks,
  Bot,
  Braces,
  Bug,
  CircleDashed,
  CircleX,
  ClipboardCheck,
  Database,
  DatabaseZap,
  Flag,
  Flame,
  FlaskConical,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Info,
  KeyRound,
  Lightbulb,
  ListOrdered,
  type LucideIcon,
  OctagonAlert,
  Package,
  Plug,
  Scale,
  Server,
  ShieldCheck,
  Shuffle,
  Sparkles,
  SlidersHorizontal,
  TriangleAlert,
  Waypoints,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type {
  BaseSource,
  BeforeMergeKind,
  CommentKind,
  FindingKind,
  FlowDetailKind,
  FlowStep,
  HighlightKind,
  PrState,
  ReplyStatus,
  ReviewLevel,
  SectionKind,
  Severity,
  Tag,
  Target,
} from "../../../skill/schema/types";

// Colors in this file. A color that carries a meaning is written by its role (danger, warn, ok, accent, agent:
// see the color roles in ../index.css), so the review levels, severities and statuses below use roles. A color
// that only tells categories apart keeps its hue, so retuning a role never moves it: the targets, the highlight
// and flow detail kinds that are not a warning, and the pull request states, which are GitHub's own colors.

// The PR type pill: a color and a Lucide icon per tag. The inbox in skill/scripts/daemon.mjs draws the same
// pill from its own copy of this list (TAGS there), so a change here needs the same change there.
export const TAGS: Record<Tag, { color: string; icon: LucideIcon }> = {
  HOTFIX: { color: "#dc2626", icon: Flame },
  SECURITY: { color: "#be123c", icon: ShieldCheck },
  FEATURE: { color: "#7c3aed", icon: Sparkles },
  FIX: { color: "#0284c7", icon: Bug },
  PERF: { color: "#0d9488", icon: Zap },
  REFACTOR: { color: "#475569", icon: Blocks },
  CHORE: { color: "#71717a", icon: Wrench },
};

export const TARGETS: Record<Target, { label: string; className: string; dot: string }> = {
  backend: {
    label: "Backend",
    className: "bg-blue-500/[0.08] text-blue-700 ring-blue-500/25 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  frontend: {
    label: "Frontend",
    className: "bg-yellow-400/[0.12] text-yellow-800 ring-yellow-500/30 dark:text-yellow-200",
    dot: "bg-yellow-400",
  },
  database: {
    label: "Database",
    className: "bg-pink-500/[0.08] text-pink-700 ring-pink-500/25 dark:text-pink-300",
    dot: "bg-pink-500",
  },
  infrastructure: {
    label: "Infrastructure",
    className: "bg-green-500/[0.08] text-green-700 ring-green-500/25 dark:text-green-300",
    dot: "bg-green-500",
  },
  cicd: {
    label: "CI/CD",
    className: "bg-orange-500/[0.08] text-orange-700 ring-orange-500/25 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  misc: {
    label: "Misc",
    className: "bg-purple-500/[0.08] text-purple-700 ring-purple-500/25 dark:text-purple-300",
    dot: "bg-purple-500",
  },
};

export const SECTIONS: Record<SectionKind, { label: string; icon: LucideIcon }> = {
  database: { label: "Database changes", icon: Database },
  infrastructure: { label: "Infrastructure changes", icon: Server },
  config: { label: "Config and env vars", icon: SlidersHorizontal },
  dependencies: { label: "Dependencies", icon: Package },
  backend: { label: "Backend changes", icon: Braces },
  frontend: { label: "Frontend changes", icon: AppWindow },
  cicd: { label: "CI/CD changes", icon: Workflow },
  tests: { label: "Tests", icon: FlaskConical },
  refactors: { label: "Refactors", icon: Shuffle },
  generated: { label: "Generated files", icon: Bot },
  other: { label: "Other files", icon: Folder },
};

// The review level is the one color a reader should pick up while scrolling: the pill on a section, the left edge of
// its card, the badge in the sidebar path and the bar in the hero all use these. `edge` is the card's left border;
// it is marked important because the `.surface` class sets the border color outside Tailwind's layers and would win.
export const REVIEW: Record<ReviewLevel, { label: string; className: string; dot: string; rail: string; edge: string; badge: string }> = {
  must: {
    label: "Must read",
    className: "bg-danger-500/[0.08] text-danger-700 ring-danger-500/25 dark:text-danger-300",
    dot: "bg-danger-500",
    rail: "bg-danger-500",
    edge: "border-l-danger-500!",
    badge: "bg-danger-500/15 text-danger-700 dark:text-danger-300",
  },
  skim: {
    label: "Skim",
    className: "bg-warn-500/[0.08] text-warn-700 ring-warn-500/25 dark:text-warn-300",
    dot: "bg-warn-500",
    rail: "bg-warn-500",
    edge: "border-l-warn-500!",
    badge: "bg-warn-500/15 text-warn-700 dark:text-warn-300",
  },
  skip: {
    label: "Skip",
    className: "bg-zinc-500/[0.08] text-zinc-600 ring-zinc-500/25 dark:text-zinc-400",
    dot: "bg-zinc-400",
    rail: "bg-zinc-400",
    edge: "border-l-zinc-400!",
    badge: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  },
};

export const HIGHLIGHTS: Record<HighlightKind, { label: string; icon: LucideIcon; className: string; tint: string }> = {
  behavior: { label: "Behavior", icon: Activity, className: "text-blue-600 dark:text-blue-400", tint: "bg-blue-500/10" },
  risk: { label: "Risk", icon: TriangleAlert, className: "text-danger-600 dark:text-danger-400", tint: "bg-danger-500/10" },
  contract: { label: "Contract", icon: Plug, className: "text-violet-600 dark:text-violet-400", tint: "bg-violet-500/10" },
  decision: { label: "Decision", icon: Lightbulb, className: "text-teal-600 dark:text-teal-400", tint: "bg-teal-500/10" },
  gap: { label: "Gap", icon: CircleDashed, className: "text-warn-600 dark:text-warn-400", tint: "bg-warn-500/10" },
  affected: { label: "Affected", icon: Waypoints, className: "text-orange-600 dark:text-orange-400", tint: "bg-orange-500/10" },
};

export const BEFORE_MERGE: Record<BeforeMergeKind, { label: string; icon: LucideIcon }> = {
  migration: { label: "Migration", icon: DatabaseZap },
  env: { label: "Env var", icon: KeyRound },
  "deploy-order": { label: "Deploy order", icon: ListOrdered },
  flag: { label: "Feature flag", icon: Flag },
  breaking: { label: "Breaking", icon: OctagonAlert },
  manual: { label: "To do", icon: ClipboardCheck },
};

export const FLOW_DETAILS: Record<FlowDetailKind, { label: string; icon: LucideIcon; className: string }> = {
  check: { label: "Check", icon: ShieldCheck, className: "text-blue-600 dark:text-blue-400" },
  rule: { label: "Rule", icon: Scale, className: "text-violet-600 dark:text-violet-400" },
  effect: { label: "Then", icon: ArrowRight, className: "text-muted" },
  error: { label: "Problem", icon: CircleX, className: "text-danger-600 dark:text-danger-400" },
  note: { label: "Note", icon: Info, className: "text-muted" },
};

export const STEP_STATUS: Record<FlowStep["status"], { label: string; className: string; node: string }> = {
  new: {
    label: "New",
    className: "bg-ok-500/10 text-ok-700 ring-ok-500/30 dark:text-ok-300",
    node: "border-ok-500 bg-ok-500",
  },
  changed: {
    label: "Changed",
    className: "bg-warn-500/10 text-warn-700 ring-warn-500/30 dark:text-warn-300",
    node: "border-warn-500 bg-warn-500",
  },
  existing: {
    label: "Existing",
    className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400",
    node: "border-zinc-400 bg-[var(--surface)]",
  },
};

export const FILE_STATUS = {
  added: { label: "New", className: "text-ok-600 dark:text-ok-400" },
  modified: { label: "Changed", className: "text-warn-600 dark:text-warn-400" },
  deleted: { label: "Deleted", className: "text-danger-600 dark:text-danger-400" },
  renamed: { label: "Renamed", className: "text-sky-600 dark:text-sky-400" },
} as const;

// Pull request states, as GitHub colors them. The inbox in skill/scripts/daemon.mjs uses the same
// colors and icons (PR_STATES there). `className` colors an icon, `pill` a label.
export const PR_STATES: Record<PrState, { label: string; icon: LucideIcon; className: string; pill: string }> = {
  OPEN: { label: "Open", icon: GitPullRequest, className: "text-emerald-600 dark:text-emerald-400", pill: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
  MERGED: { label: "Merged", icon: GitMerge, className: "text-violet-600 dark:text-violet-400", pill: "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300" },
  CLOSED: { label: "Closed", icon: GitPullRequestClosed, className: "text-red-600 dark:text-red-400", pill: "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300" },
};

export const BASE_SOURCE: Record<BaseSource, string> = {
  argument: "you picked it",
  "open-pr": "from the open PR",
  config: "from .pr-report.json",
  "default-branch": "repo default branch",
  guess: "best guess",
};

export const COMMENT_KINDS: Record<CommentKind, { label: string; className: string }> = {
  fix: { label: "Fix", className: "bg-accent/10 text-accent ring-accent/30" },
  question: { label: "Question", className: "bg-agent-500/10 text-agent-700 ring-agent-500/30 dark:text-agent-300" },
  nit: { label: "Nit", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400" },
  accepted: { label: "It's fine", className: "bg-ok-500/10 text-ok-700 ring-ok-500/30 dark:text-ok-300" },
  decision: { label: "Answer", className: "bg-agent-500/10 text-agent-700 ring-agent-500/30 dark:text-agent-300" },
};

export const REPLY_STATUS: Record<ReplyStatus, { label: string; className: string }> = {
  fixed: { label: "Fixed", className: "bg-ok-500/10 text-ok-700 ring-ok-500/30 dark:text-ok-300" },
  answered: { label: "Answered", className: "bg-accent/10 text-accent ring-accent/30" },
  wontfix: { label: "Won't fix", className: "bg-warn-500/10 text-warn-700 ring-warn-500/30 dark:text-warn-300" },
  noted: { label: "Noted", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400" },
};

export const SEVERITY: Record<Severity, { label: string; className: string; border: string }> = {
  high: { label: "High", className: "bg-danger-500/10 text-danger-700 ring-danger-500/30 dark:text-danger-300", border: "border-danger-500/40" },
  medium: { label: "Medium", className: "bg-warn-500/10 text-warn-700 ring-warn-500/30 dark:text-warn-300", border: "border-warn-500/40" },
  low: { label: "Low", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400", border: "border-zinc-500/30" },
};

export const FINDING_KINDS: Record<FindingKind, { label: string; icon: LucideIcon }> = {
  secret: { label: "Secret", icon: KeyRound },
  migration: { label: "Migration", icon: DatabaseZap },
};

// Where the project lives, for the help and bug report links in the user menu.
export const PROJECT = {
  repo: "https://github.com/bashovski/pr-report",
  issues: "https://github.com/bashovski/pr-report/issues/new",
  readme: "https://github.com/bashovski/pr-report#readme",
};
