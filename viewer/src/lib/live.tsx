import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { Bundle, CommentKind, LiveQuestion, Ref, ReviewComment } from "../../../skill/schema/types";

// Live state of a review, streamed from the pr-report daemon.
//
// Browsers allow only 6 open connections per address, and every review tab talks to the same daemon.
// So one tab (the holder of a Web Lock) keeps the single event stream and relays it to the other tabs
// over a BroadcastChannel. When that tab closes, the lock moves to another tab, which opens the stream.

export type ReviewConfig = { live: true; id: string; round: number; token: string; api: string };

declare global {
  interface Window {
    __PR_REVIEW__?: ReviewConfig;
  }
}

export type Phase = "reviewing" | "sent" | "planning" | "working" | "done";
export type CommentStatus = { status: "working" | "fixed" | "answered" | "wontfix" | "noted"; text: string | null; ref?: Ref; at: string };
export type PlanStep = { comments: string[]; where: string; kind: CommentKind | "skip"; action: string };
export type AgentPlan = {
  round: number;
  steps: PlanStep[];
  note: string | null;
  createdAt: string;
  decision: { decision: "approve" | "changes"; note: string | null; at: string } | null;
};

export type LiveState = {
  id: string;
  round: number;
  phase: Phase;
  statuses: Record<string, CommentStatus>;
  plan: AgentPlan | null;
  questions: LiveQuestion[];
  submitted: ReviewComment[];
  lastAgentActivity: string | null;
  updatedAt: string;
};

type Message = { type: "state"; state: LiveState } | { type: "hello" } | { type: "connection"; connected: boolean };

const config = window.__PR_REVIEW__;
const listeners = new Set<(m: Message) => void>();
const latest = new Map<string, LiveState>();
let connected = false;

const emit = (m: Message) => {
  if (m.type === "state") latest.set(m.state.id, m.state);
  if (m.type === "connection") connected = m.connected;
  for (const l of listeners) l(m);
};

function startStream() {
  if (!config) return;
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("pr-report-live");
  const lead = () =>
    new Promise<void>(() => {
      const connect = () => {
        const source = new EventSource(`/api/events?token=${config.token}&watch=*`);
        source.onopen = () => {
          emit({ type: "connection", connected: true });
          channel?.postMessage({ type: "connection", connected: true });
        };
        source.onerror = () => {
          emit({ type: "connection", connected: false });
          channel?.postMessage({ type: "connection", connected: false });
          // EventSource retries network errors by itself, but gives up on an HTTP error (a restarting daemon).
          if (source.readyState === EventSource.CLOSED) window.setTimeout(connect, 3000);
        };
        source.addEventListener("state", (e) => {
          const m: Message = { type: "state", state: JSON.parse((e as MessageEvent).data) };
          emit(m);
          channel?.postMessage(m);
        });
      };
      connect();
      // Tabs that open later ask for what the stream already sent.
      channel?.addEventListener("message", (e) => {
        if ((e.data as Message).type !== "hello") return;
        channel.postMessage({ type: "connection", connected });
        for (const state of latest.values()) channel.postMessage({ type: "state", state });
      });
    });

  if (channel && navigator.locks) {
    channel.addEventListener("message", (e) => emit(e.data as Message));
    void navigator.locks.request("pr-report-live-stream", lead);
    channel.postMessage({ type: "hello" });
  } else {
    void lead();
  }
}

startStream();

const Ctx = createContext<{ live: LiveState | null; connected: boolean; config: ReviewConfig | null }>({ live: null, connected: false, config: null });

export const LiveProvider = ({ children }: { children: ReactNode }) => {
  const [live, setLive] = useState<LiveState | null>(() => (config ? (latest.get(config.id) ?? null) : null));
  const [isConnected, setConnected] = useState(connected);

  // Tell the daemon this review is on screen, so the agent does not open another tab for each round.
  useEffect(() => {
    if (!config) return;
    const tab = Math.random().toString(36).slice(2);
    const checkIn = () =>
      fetch(`${config.api}/presence`, {
        method: "POST",
        headers: { "x-review-token": config.token, "content-type": "application/json" },
        body: JSON.stringify({ tab }),
      }).catch(() => {});
    void checkIn();
    const id = window.setInterval(checkIn, 20_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!config) return;
    const onMessage = (m: Message) => {
      if (m.type === "state" && m.state.id === config.id) setLive(m.state);
      if (m.type === "connection") setConnected(m.connected);
    };
    listeners.add(onMessage);
    return () => {
      listeners.delete(onMessage);
    };
  }, []);

  return <Ctx.Provider value={{ live, connected: isConnected, config: config ?? null }}>{children}</Ctx.Provider>;
};

export const useLive = () => useContext(Ctx);

// Loads another round's report data from the daemon.
export async function fetchRound(round: number): Promise<Bundle> {
  const res = await fetch(`${config!.api}/bundle?round=${round}`, { headers: { "x-review-token": config!.token } });
  if (!res.ok) throw new Error(`Could not load round ${round}`);
  return res.json();
}

