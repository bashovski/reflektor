import { storage } from "./prefs";

// The setup page: /setup on the review daemon, which the installer opens after an install, or
// /setup on the Vite dev server. The daemon puts the page's token here, the same way it does for
// a review page, so the page can ask it about the tools on this machine.
export type SetupConfig = { token: string };

declare global {
  interface Window {
    __PR_SETUP__?: SetupConfig;
  }
}

export const isSetupPage = () => Boolean(window.__PR_SETUP__) || window.location.pathname === "/setup";

// Written when setup finishes or is skipped, so this browser is never asked again. Per browser,
// like the preferences setup writes.
export const SETUP_KEY = "reflektor:setup";
export const setupDone = () => storage.get<{ at: string } | null>(SETUP_KEY, null) !== null;
export const markSetupDone = () => storage.set(SETUP_KEY, { at: new Date().toISOString() });

// Where the page goes when setup ends: the inbox, which greets a first-timer, or the sample report
// on the dev server.
export const afterSetup = () => (window.__PR_SETUP__ ? "/?welcome" : "/");
