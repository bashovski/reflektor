import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Bundle } from "../../skill/schema/types";
import { App } from "./components/App";
import { Panel } from "./components/Panel";
import { SettingsRoute } from "./components/SettingsRoute";
import { Setup } from "./components/Setup";
import { fetchRound, LiveProvider, useLive } from "./lib/live";
import { isPanelPage } from "./lib/panel";
import { PreferencesProvider } from "./lib/prefs";
import { RoundCtx } from "./lib/rounds";
import { isSettingsPage } from "./lib/settings-page";
import { isSetupPage } from "./lib/setup";
import "./index.css";

const readBundle = (): Bundle | null => {
  const text = document.getElementById("reflektor-data")?.textContent?.trim() ?? "";
  return text.startsWith("{") ? (JSON.parse(text) as Bundle) : null;
};

// When the agent publishes the round on screen again (fresh coverage, check results), load its data
// in place. Comments, viewed files and open sections stay.
const ReloadRepublished = ({ bundle, onReload }: { bundle: Bundle; onReload: (next: Bundle) => void }) => {
  const { live } = useLive();
  const builtAt = live && live.round === bundle.round ? live.roundBuiltAt : null;
  useEffect(() => {
    if (!builtAt || builtAt === bundle.builtAt) return;
    fetchRound(bundle.round).then(onReload, () => {});
  }, [builtAt, bundle.builtAt, bundle.round, onReload]);
  return null;
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
      <ReloadRepublished bundle={bundle} onReload={setBundle} />
      <RoundCtx.Provider value={{ showRound }}>
        <App key={bundle.round} bundle={bundle} />
      </RoundCtx.Provider>
    </LiveProvider>
  );
};

// An exported report carries its data in the page. The daemon's page loads it for the round in the URL.
const Load = () => {
  const [bundle, setBundle] = useState<Bundle | null>(readBundle);
  const [error, setError] = useState<string | null>(window.__PR_REVIEW__ ? null : "No report data found in this file.");
  useEffect(() => {
    const config = window.__PR_REVIEW__;
    if (bundle || !config) return;
    fetchRound(config.round).then(setBundle, (e: Error) => setError(e.message));
  }, [bundle]);
  if (bundle) return <Root initial={bundle} />;
  return <p className="p-10 text-sm text-muted">{error ?? "Loading the report…"}</p>;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreferencesProvider>{isPanelPage() ? <Panel /> : isSetupPage() ? <Setup /> : isSettingsPage() ? <SettingsRoute /> : <Load />}</PreferencesProvider>
  </StrictMode>,
);
