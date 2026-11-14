// The report's own dialogs, for a page that is not part of this app.
//
// The inbox is plain HTML written by the daemon, so it cannot draw Help or the cache purge itself, and a
// second copy written by hand would drift from this one. Instead the inbox loads this app at /panel, in a frame that
// covers the window and is see-through, and tells it which dialog to open (see components/Panel.tsx). So each dialog
// exists once and is the same from every page.
export type PanelName = "help" | "purge";
export type PanelConfig = { token: string };

declare global {
  interface Window {
    __PR_PANEL__?: PanelConfig;
  }
}

export const isPanelPage = () => Boolean(window.__PR_PANEL__);

// The token the daemon gave this page, whichever kind of page it is.
export const pageToken = () => window.__PR_REVIEW__?.token ?? window.__PR_PANEL__?.token ?? window.__PR_SETUP__?.token ?? window.__PR_SETTINGS__?.token ?? "";
