import { createContext, useContext } from "react";

// Lets the round banner swap the page to another round's report data.
export const RoundCtx = createContext<{ showRound: (round: number) => Promise<void> }>({ showRound: async () => {} });
export const useRounds = () => useContext(RoundCtx);
