import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Bundle } from "../../skill/schema/types";
import { App } from "./components/App";
import { fetchRound, LiveProvider } from "./lib/live";
import { RoundCtx } from "./lib/rounds";
import "./index.css";

const readBundle = (): Bundle | null => {
  const text = document.getElementById("pr-report-data")?.textContent?.trim() ?? "";
  return text.startsWith("{") ? (JSON.parse(text) as Bundle) : null;
};

// Holds the report data so a new round can replace it in place, without reloading the page.
const Root = ({ initial }: { initial: Bundle }) => {
  const [bundle, setBundle] = useState(initial);
  const showRound = useCallback(async (round: number) => {
    setBundle(await fetchRound(round));
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <LiveProvider>
      <RoundCtx.Provider value={{ showRound }}>
        <App key={bundle.round} bundle={bundle} />
      </RoundCtx.Provider>
    </LiveProvider>
  );
};

const bundle = readBundle();
createRoot(document.getElementById("root")!).render(
  <StrictMode>{bundle ? <Root initial={bundle} /> : <p className="p-10 text-sm text-zinc-500">No report data found in this file.</p>}</StrictMode>,
);
