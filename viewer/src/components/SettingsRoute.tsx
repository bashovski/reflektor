import { Inbox } from "lucide-react";
import { settingsReturn } from "../lib/settings-page";
import { SettingsPage } from "./Settings";
import { Logo } from "./ui";

// /settings on the daemon: the settings page with a plain top bar that leads back to the inbox.
export const SettingsRoute = () => {
  const back = settingsReturn();
  return (
    <SettingsPage
      back={{ label: back === "/" ? "Back to all reviews" : "Back", href: back }}
      topBar={
        <header data-top-bar className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
            <a href="/" title="All reviews" aria-label="All reviews" className="inline-flex shrink-0 rounded-control p-1 hover:bg-zinc-500/10">
              <Logo className="h-6" />
            </a>
            <span aria-hidden className="h-5 w-px shrink-0 bg-[var(--border)]" />
            <span className="text-sm font-medium">Settings</span>
            <a href="/" className="ml-auto inline-flex items-center gap-1.5 rounded-control px-2 py-1.5 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400">
              <Inbox className="size-3.5" /> All reviews
            </a>
          </div>
        </header>
      }
    />
  );
};
