import type { AgentInfo } from "../../../skill/schema/types";
import { useLive } from "./live";
import { useReport } from "./state";

// The words the page uses for the coding agent on the other side of the review. They come from whoever
// called last (the daemon keeps it per review, see skill/scripts/agent.mts), else from the build, and
// when nobody said, the page speaks of "your agent".
export type Agent = {
  known: boolean;
  // In the middle of a sentence: "Send to Claude", "Send to your agent".
  name: string;
  // At the start of one: "Claude is working", "Your agent is working".
  Name: string;
  // In front of a noun: "No Claude session", "No agent session".
  noun: string;
  // How to pick the review up in a new session: `${resumeLead} ${resumeCommand}`.
  resumeLead: string;
  resumeCommand: string;
};

const GENERIC: Agent = {
  known: false,
  name: "your agent",
  Name: "Your agent",
  noun: "agent",
  resumeLead: "Tell your agent:",
  resumeCommand: "resume the PR report review",
};

export const describeAgent = (info: AgentInfo | null | undefined): Agent => {
  if (!info?.name) return GENERIC;
  return {
    known: true,
    name: info.name,
    Name: info.name,
    noun: info.name,
    resumeLead: info.resume ? `In ${info.product}, run` : `Tell ${info.name}:`,
    resumeCommand: info.resume ?? GENERIC.resumeCommand,
  };
};

export const useAgent = (): Agent => {
  const { live, config } = useLive();
  const { bundle } = useReport();
  return describeAgent(live?.agent ?? config?.agent ?? bundle.agent);
};
