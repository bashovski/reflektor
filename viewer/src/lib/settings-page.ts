// The settings page on its own: /settings on the review daemon, opened from the inbox. A report shows the same page
// in place of the review instead (see components/App.tsx), so it keeps its state.
export type SettingsConfig = { token: string };

declare global {
  interface Window {
    __PR_SETTINGS__?: SettingsConfig;
  }
}

export const isSettingsPage = () => Boolean(window.__PR_SETTINGS__) || window.location.pathname === "/settings";

// Where "Back" goes: the page that opened Settings when it is one of this daemon's own, else the inbox.
export const settingsReturn = () => {
  const from = new URLSearchParams(window.location.search).get("from") ?? "";
  return from.startsWith("/") && !from.startsWith("//") ? from : "/";
};
