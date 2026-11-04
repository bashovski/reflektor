import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, CommentKind, CommentTarget, LiveQuestion, ReviewComment } from "../../../skill/schema/types";
import { SECTIONS } from "./meta";

// Review comments live here. Served by serve.mjs, the page saves them to the repo's git folder
// and can send them to Claude. Opened as a plain file, they stay in this browser and can be copied.

declare global {
  interface Window {
    __PR_REVIEW__?: { token: string; round: number };
  }
}

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
      return `${fileName(t.path)} ${t.start === t.end ? `line ${t.start}` : `lines ${t.start}-${t.end}`}${t.side === "old" ? " (old version)" : ""}`;
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
  const server = window.__PR_REVIEW__;
  const mode = server ? "server" : "local";
  const round = server?.round ?? bundle.round;
  const { repo, branch } = bundle.diff;
  const storageKey = `pr-report:review:${repo.owner ?? ""}/${repo.name}:${branch.snapshot}`;

  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sent, setSent] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);

  const api = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(path, {
        method,
        headers: { "x-review-token": server!.token, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      return res.json();
    },
    [server],
  );

  useEffect(() => {
    if (mode === "server") {
      api("/api/review", "GET")
        .then((data) => setComments(data.comments ?? []))
        .catch((e: Error) => setError(`Could not load saved comments: ${e.message}`))
        .finally(() => setLoaded(true));
    } else {
      try {
        setComments(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
      } catch {
        // Storage can be blocked; comments then last for this tab only.
      }
      setLoaded(true);
    }
  }, [mode, api, storageKey]);

  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded || sent) return;
    if (mode === "local") {
      try {
        localStorage.setItem(storageKey, JSON.stringify(comments));
      } catch {
        // See above.
      }
      return;
    }
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api("/api/review", "PUT", { comments })
        .then(() => setSaveState("saved"))
        .catch((e: Error) => {
          setSaveState("error");
          setError(`Could not save: ${e.message}. Is the review server still running?`);
        });
    }, 400);
  }, [comments, loaded, sent, mode, api, storageKey]);

  const add = useCallback((target: CommentTarget, fields: { text?: string; kind?: CommentKind }) => {
    setComments((prev) => [...prev, { id: newId(), target, text: fields.text ?? "", kind: fields.kind, createdAt: new Date().toISOString() }]);
  }, []);
  const update = useCallback((id: string, fields: { text?: string; kind?: CommentKind }) => {
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, ...fields } : c)));
  }, []);
  const remove = useCallback((id: string) => setComments((prev) => prev.filter((c) => c.id !== id)), []);

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
      await api("/api/submit", "POST", { comments, branch: branch.head, headSha: branch.headSha, snapshot: branch.snapshot });
      setSent(true);
      setComposer(null);
    } catch (e) {
      setError(`Could not send: ${(e as Error).message}. Is the review server still running?`);
    }
  }, [api, comments, branch]);

  const copyForClaude = useCallback(() => copyText(toMarkdown(bundle, round, comments)), [bundle, round, comments]);

  // Live questions: sent to the server now, answered by the agent while the review goes on.
  const [questions, setQuestions] = useState<LiveQuestion[]>([]);
  const pending = questions.some((q) => !q.answer);
  const loadQuestions = useCallback(() => {
    if (mode !== "server") return;
    api("/api/questions", "GET")
      .then((data) => setQuestions(data.questions ?? []))
      .catch(() => {});
  }, [mode, api]);
  useEffect(loadQuestions, [loadQuestions]);
  useEffect(() => {
    if (!pending || sent) return;
    const id = window.setInterval(loadQuestions, 3000);
    return () => window.clearInterval(id);
  }, [pending, sent, loadQuestions]);

  const ask = useCallback(
    async (target: CommentTarget, text: string) => {
      const question: LiveQuestion = { id: `q_${newId().slice(2)}`, target, text, askedAt: new Date().toISOString(), answer: null };
      setQuestions((prev) => [...prev, question]);
      try {
        await api("/api/questions", "POST", { id: question.id, target, text });
      } catch (e) {
        setError(`Could not ask: ${(e as Error).message}. Is the review server still running?`);
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

  const value: ReviewState = {
    mode,
    round,
    comments,
    editable: !sent,
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
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
