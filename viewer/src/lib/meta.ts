import {
  Activity,
  AppWindow,
  ArrowRight,
  Bot,
  Braces,
  CircleDashed,
  CircleX,
  ClipboardCheck,
  Database,
  DatabaseZap,
  Flag,
  FlaskConical,
  Folder,
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
  SlidersHorizontal,
  TriangleAlert,
  Waypoints,
  Workflow,
} from "lucide-react";
import type {
  BaseSource,
  BeforeMergeKind,
  CommentKind,
  FindingKind,
  FlowDetailKind,
  FlowStep,
  HighlightKind,
  ReplyStatus,
  ReviewLevel,
  SectionKind,
  Severity,
  Tag,
  Target,
} from "../../../skill/schema/types";

export const TAGS: Record<Tag, string> = {
  HOTFIX: "bg-red-600 text-white",
  SECURITY: "bg-rose-700 text-white",
  FEATURE: "bg-violet-600 text-white",
  FIX: "bg-sky-600 text-white",
  PERF: "bg-teal-600 text-white",
  REFACTOR: "bg-slate-600 text-white",
  CHORE: "bg-zinc-500 text-white",
};

export const TARGETS: Record<Target, { label: string; className: string; dot: string }> = {
  backend: {
    label: "Backend",
    className: "bg-blue-500/10 text-blue-700 ring-blue-500/30 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  frontend: {
    label: "Frontend",
    className: "bg-yellow-400/15 text-yellow-800 ring-yellow-500/40 dark:text-yellow-200",
    dot: "bg-yellow-400",
  },
  database: {
    label: "Database",
    className: "bg-pink-500/10 text-pink-700 ring-pink-500/30 dark:text-pink-300",
    dot: "bg-pink-500",
  },
  infrastructure: {
    label: "Infrastructure",
    className: "bg-green-500/10 text-green-700 ring-green-500/30 dark:text-green-300",
    dot: "bg-green-500",
  },
  cicd: {
    label: "CI/CD",
    className: "bg-orange-500/10 text-orange-700 ring-orange-500/30 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  misc: {
    label: "Misc",
    className: "bg-purple-500/10 text-purple-700 ring-purple-500/30 dark:text-purple-300",
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

export const REVIEW: Record<ReviewLevel, { label: string; className: string; dot: string }> = {
  must: {
    label: "Must read",
    className: "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300",
    dot: "bg-red-500",
  },
  skim: {
    label: "Skim",
    className: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  skip: {
    label: "Skip",
    className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400",
    dot: "bg-zinc-400",
  },
};

export const HIGHLIGHTS: Record<HighlightKind, { label: string; icon: LucideIcon; className: string }> = {
  behavior: { label: "Behavior", icon: Activity, className: "text-blue-600 dark:text-blue-400" },
  risk: { label: "Risk", icon: TriangleAlert, className: "text-red-600 dark:text-red-400" },
  contract: { label: "Contract", icon: Plug, className: "text-violet-600 dark:text-violet-400" },
  decision: { label: "Decision", icon: Lightbulb, className: "text-teal-600 dark:text-teal-400" },
  gap: { label: "Gap", icon: CircleDashed, className: "text-amber-600 dark:text-amber-400" },
  affected: { label: "Affected", icon: Waypoints, className: "text-orange-600 dark:text-orange-400" },
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
  effect: { label: "Then", icon: ArrowRight, className: "text-zinc-500" },
  error: { label: "Problem", icon: CircleX, className: "text-red-600 dark:text-red-400" },
  note: { label: "Note", icon: Info, className: "text-zinc-500" },
};

export const STEP_STATUS: Record<FlowStep["status"], { label: string; className: string; node: string }> = {
  new: {
    label: "New",
    className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
    node: "border-emerald-500 bg-emerald-500",
  },
  changed: {
    label: "Changed",
    className: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
    node: "border-amber-500 bg-amber-500",
  },
  existing: {
    label: "Existing",
    className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400",
    node: "border-zinc-400 bg-[var(--surface)]",
  },
};

export const FILE_STATUS = {
  added: { label: "New", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { label: "Changed", className: "text-amber-600 dark:text-amber-400" },
  deleted: { label: "Deleted", className: "text-red-600 dark:text-red-400" },
  renamed: { label: "Renamed", className: "text-sky-600 dark:text-sky-400" },
} as const;

export const BASE_SOURCE: Record<BaseSource, string> = {
  argument: "you picked it",
  "open-pr": "from the open PR",
  config: "from .pr-report.json",
  "default-branch": "repo default branch",
  guess: "best guess",
};

export const COMMENT_KINDS: Record<CommentKind, { label: string; className: string }> = {
  fix: { label: "Fix", className: "bg-blue-500/10 text-blue-700 ring-blue-500/30 dark:text-blue-300" },
  question: { label: "Question", className: "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300" },
  nit: { label: "Nit", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400" },
  accepted: { label: "It's fine", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
  decision: { label: "Answer", className: "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300" },
};

export const REPLY_STATUS: Record<ReplyStatus, { label: string; className: string }> = {
  fixed: { label: "Fixed", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
  answered: { label: "Answered", className: "bg-blue-500/10 text-blue-700 ring-blue-500/30 dark:text-blue-300" },
  wontfix: { label: "Won't fix", className: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300" },
  noted: { label: "Noted", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400" },
};

export const SEVERITY: Record<Severity, { label: string; className: string; border: string }> = {
  high: { label: "High", className: "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300", border: "border-red-500/40" },
  medium: { label: "Medium", className: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300", border: "border-amber-500/40" },
  low: { label: "Low", className: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400", border: "border-zinc-500/30" },
};

export const FINDING_KINDS: Record<FindingKind, { label: string; icon: LucideIcon }> = {
  secret: { label: "Secret", icon: KeyRound },
  migration: { label: "Migration", icon: DatabaseZap },
};
