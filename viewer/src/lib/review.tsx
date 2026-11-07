import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, CommentKind, CommentTarget, LiveQuestion, ReviewComment } from "../../../skill/schema/types";
import { type AgentPlan, type CommentStatus, type LiveState, type Phase, useLive } from "./live";
import { SECTIONS } from "./meta";

// Review comments live here. Served by the pr-report daemon, the page saves them to the repo's git
// folder, asks live questions, and sends the review to Claude. Opened as a plain file, comments stay
// in this browser and can be copied.

export type SaveState = "idle" | "saving" | "saved" | "error";
type Composer = { key: string; target: CommentTarget; editingId?: string; kind?: CommentKind };

type ReviewState = {
  mode: "server" | "local";
  round: number;
  comments: ReviewComment[];
  editable: boolean;
  sent: boolean;
  saveState: SaveState;
  error: string | null;
  add: (target: CommentTarget, fields: { text?: string; kind?: CommentKind }) => void;
  update: (id: string, fields: { text?: string; kind?: CommentKind }) => void;
  remove: (id: string) => void;
  commentsFor: (target: CommentTarget) => ReviewComment[];
  composer: Composer | null;
  openComposer: (target: CommentTarget, options?: { editingId?: string; kind?: CommentKind }) => void;
  closeComposer: () => void;
  submit: () => Promise<void>;
  copyForClaude: () => Promise<boolean>;
  questions: LiveQuestion[];
  questionsFor: (target: CommentTarget) => LiveQuestion[];
  ask: (target: CommentTarget, text: string) => Promise<void>;
  // Live review state from the daemon (null when opened as a file).
  phase: Phase | null;
  latestRound: number;
  plan: AgentPlan | null;
  statusOf: (commentId: string) => CommentStatus | undefined;
  decidePlan: (decision: "approve" | "changes", kinds: Record<number, string>, note: string) => Promise<void>;
  connected: boolean;
  lastAgentActivity: string | null;
  // An agent waits for this review's events, and since when the oldest event waits for one.
  listening: boolean;
  undeliveredSince: string | null;
  drift: LiveState["drift"];
  // Asks the agent to rebuild this round for the code as it is now.
  requestRefresh: () => Promise<void>;
};

const Ctx = createContext<ReviewState | null>(null);

export const useReview = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("useReview outside provider");
  return value;
};

export const targetKey = (t: CommentTarget): string => {
  switch (t.type) {
    case "line":
      return `line:${t.path}:${t.side}:${t.start}-${t.end}`;
    case "file":
      return `file:${t.path}`;
    case "highlight":
      return `highlight:${t.section}:${t.index}`;
    case "question":
      return `question:${t.section}:${t.index}`;
    case "flow-detail":
      return `flow:${t.flow}:${t.step}:${t.detail}`;
    case "before-merge":
      return `before-merge:${t.index}`;
    case "plan-item":
      return `plan:${t.index}`;
    case "report":
      return "report";
  }
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;
const clip = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export const describeTarget = (t: CommentTarget): string => {
  switch (t.type) {
    case "line":
      return `${fileName(t.path)} ${t.start === t.end ? `line ${t.start}` : `lines ${t.start}-${t.end}`}${t.side === "old" ? (t.round ? ` (as in round ${t.round})` : " (old version)") : ""}`;
    case "file":
      return fileName(t.path);
    case "highlight":
      return `${SECTIONS[t.section].label}: ${clip(t.text.replace(/\n/g, " "))}`;
    case "question":
      return `Question: ${clip(t.text)}`;
    case "flow-detail":
      return `${t.symbol}: ${clip(t.text.replace(/\n/g, " "))}`;
    case "before-merge":
      return `Before you merge: ${clip(t.text)}`;
    case "plan-item":
      return `Plan: ${clip(t.text)}`;
    case "report":
      return "Whole report";
  }
};

const newId = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const indent = (text: string, pad = "   ") =>
  text
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");

// Markdown for pasting into any agent when the page has no server to send to.
const toMarkdown = (bundle: Bundle, round: number, comments: ReviewComment[]) => {
  const { branch } = bundle.diff;
  const head = `Review of ${branch.head} (${branch.headSha.slice(0, 7)}), round ${round}: ${comments.length} ${comments.length === 1 ? "comment" : "comments"}.`;
  const where = (t: CommentTarget) => {
    switch (t.type) {
      case "line":
        return `${t.path} lines ${t.start}-${t.end} (${t.side})`;
      case "file":
        return t.path;
      case "highlight":
        return `${SECTIONS[t.section].label}, ${t.kind}`;
      case "question":
        return `${SECTIONS[t.section].label}, question`;
      case "flow-detail":
        return `Flow step ${t.symbol}`;
      case "before-merge":
        return "Before you merge";
      case "plan-item":
        return `Plan item (${t.status})`;
      case "report":
        return "The whole change";
    }
  };
  const ask =
    "For each comment: work out its kind when none is given (fix, question, nit), show me a numbered plan, and wait for my OK before changing code. An empty comment marked fix means: do the suggested fix.";
  const items = comments.map((c, i) => {
    const t = c.target;
    const lines = [`${i + 1}. [${c.kind ?? "infer"}] ${where(t)}`];
    if (t.type === "line") lines.push(indent(["```", t.code, "```"].join("\n")));
    if ("text" in t) lines.push(indent(`About: ${t.text.replace(/\n/g, " ")}`));
    if ("fix" in t && t.fix) lines.push(indent(`Suggested fix: ${t.fix.replace(/\n/g, " ")}`));
    lines.push(indent(c.text || (c.kind === "accepted" ? "(Fine as it is.)" : "(Do the suggested fix.)")));
    return lines.join("\n");
  });
  return [head, ask, "", ...items].join("\n");
};

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
};

export const ReviewProvider = ({ bundle, children }: { bundle: Bundle; children: ReactNode }) => {
  const { live, connected, config } = useLive();
  const mode = config ? "server" : "local";
  const round = bundle.round;
  const { repo, branch } = bundle.diff;
  const storageKey = `pr-report:review:${repo.owner ?? ""}/${repo.name}:${branch.snapshot}`;

  // A round can be edited only while it is the latest one and has not been sent.
  const current = !live || live.round === round;
  const phase: Phase | null = live ? (current ? live.phase : "done") : null;
  const sent = mode === "server" && phase !== null && phase !== "reviewing";

  const [draft, setDraft] = useState<ReviewComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);

  const api = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(`${config!.api}/${path}`, {
        method,
        headers: { "x-review-token": config!.token, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      return res.json();
    },
    [config],
  );

  useEffect(() => {
    if (mode === "server") {
      if (!current) return setLoaded(true);
      api("draft", "GET")
        .then((data) => setDraft(data.comments ?? []))
        .catch((e: Error) => setError(`Could not load saved comments: ${e.message}`))
        .finally(() => setLoaded(true));
    } else {
      try {
        setDraft(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
      } catch {
        // Storage can be blocked; comments then last for this tab only.
      }
      setLoaded(true);
    }
  }, [mode, api, storageKey, current]);

  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded || sent) return;
    if (mode === "local") {
      try {
        localStorage.setItem(storageKey, JSON.stringify(draft));
      } catch {
        // See above.
      }
      return;
    }
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api("draft", "PUT", { comments: draft })
        .then(() => setSaveState("saved"))
        .catch((e: Error) => {
          setSaveState("error");
          setError(`Could not save: ${e.message}`);
        });
    }, 400);
  }, [draft, loaded, sent, mode, api, storageKey]);

  // After sending, the page shows what was sent, so a reload or another tab sees the same comments.
  const comments = sent && live && current ? live.submitted : draft;

  const add = useCallback((target: CommentTarget, fields: { text?: string; kind?: CommentKind }) => {
    setDraft((prev) => [...prev, { id: newId(), target, text: fields.text ?? "", kind: fields.kind, createdAt: new Date().toISOString() }]);
  }, []);
  const update = useCallback((id: string, fields: { text?: string; kind?: CommentKind }) => {
    setDraft((prev) => prev.map((c) => (c.id === id ? { ...c, ...fields } : c)));
  }, []);
  const remove = useCallback((id: string) => setDraft((prev) => prev.filter((c) => c.id !== id)), []);

  const byKey = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const key = targetKey(c.target);
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return map;
  }, [comments]);
  const commentsFor = useCallback((target: CommentTarget) => byKey.get(targetKey(target)) ?? [], [byKey]);

  const openComposer = useCallback(
    (target: CommentTarget, options?: { editingId?: string; kind?: CommentKind }) =>
      setComposer({ key: targetKey(target), target, editingId: options?.editingId, kind: options?.kind }),
    [],
  );
  const closeComposer = useCallback(() => setComposer(null), []);

  const submit = useCallback(async () => {
    setError(null);
    try {
      window.clearTimeout(saveTimer.current);
      await api("submit", "POST", { comments: draft, headSha: branch.headSha, snapshot: branch.snapshot });
      setComposer(null);
    } catch (e) {
      setError(`Could not send: ${(e as Error).message}`);
    }
  }, [api, draft, branch]);

  const copyForClaude = useCallback(() => copyText(toMarkdown(bundle, round, comments)), [bundle, round, comments]);

  // Live questions: the daemon streams them back with answers. Asked ones show at once, before the stream confirms them.
  const [asked, setAsked] = useState<LiveQuestion[]>([]);
  const questions = useMemo(() => {
    const fromLive = current ? (live?.questions ?? []) : [];
    return [...fromLive, ...asked.filter((q) => !fromLive.some((x) => x.id === q.id))];
  }, [live, asked, current]);

  const ask = useCallback(
    async (target: CommentTarget, text: string) => {
      const question: LiveQuestion = { id: `q_${newId().slice(2)}`, target, text, askedAt: new Date().toISOString(), answer: null };
      setAsked((prev) => [...prev, question]);
      try {
        await api("questions", "POST", { id: question.id, target, text });
      } catch (e) {
        setError(`Could not ask: ${(e as Error).message}`);
      }
    },
    [api],
  );

  const questionsByKey = useMemo(() => {
    const map = new Map<string, LiveQuestion[]>();
    for (const q of questions) map.set(targetKey(q.target), [...(map.get(targetKey(q.target)) ?? []), q]);
    return map;
  }, [questions]);
  const questionsFor = useCallback((target: CommentTarget) => questionsByKey.get(targetKey(target)) ?? [], [questionsByKey]);

  const statusOf = useCallback((commentId: string) => (current ? live?.statuses[commentId] : undefined), [live, current]);

  const decidePlan = useCallback(
    async (decision: "approve" | "changes", kinds: Record<number, string>, note: string) => {
      setError(null);
      try {
        await api("plan-decision", "POST", { decision, kinds, note: note.trim() || null });
      } catch (e) {
        setError(`Could not send the decision: ${(e as Error).message}`);
      }
    },
    [api],
  );

  const requestRefresh = useCallback(async () => {
    setError(null);
    try {
      await api("refresh", "POST", {});
    } catch (e) {
      setError(`Could not ask for an update: ${(e as Error).message}`);
    }
  }, [api]);

  const value: ReviewState = {
    mode,
    round,
    comments,
    editable: !sent && current,
    sent,
    saveState,
    error,
    add,
    update,
    remove,
    commentsFor,
    composer,
    openComposer,
    closeComposer,
    submit,
    copyForClaude,
    questions,
    questionsFor,
    ask,
    phase,
    latestRound: live?.round ?? round,
    plan: current ? (live?.plan ?? null) : null,
    statusOf,
    decidePlan,
    connected,
    lastAgentActivity: live?.lastAgentActivity ?? null,
    // A file opened without the daemon has no agent to listen.
    listening: live?.listening ?? true,
    undeliveredSince: current ? (live?.undeliveredSince ?? null) : null,
    drift: current ? (live?.drift ?? null) : null,
    requestRefresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
