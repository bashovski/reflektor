import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { markSetupDone, setupDone } from "../lib/setup";

// For a browser that never saw the setup page: the installer opens it, but not for a --no-open install,
// a copy made by hand, or a second browser. One line above the report, gone for good once the setup
// runs or the reader waves it away.
export const SetupBanner = () => {
  const [hidden, setHidden] = useState(() => !window.__PR_REVIEW__ || setupDone());
  if (hidden) return null;
  const dismiss = () => {
    markSetupDone();
    setHidden(true);
  };
  return (
    <div className="border-b border-agent-500/30 bg-agent-50 dark:bg-agent-950/50">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm sm:px-6">
        <Sparkles className="size-4 shrink-0 text-agent-600 dark:text-agent-400" />
        <span>New here? A one-minute setup checks your tools and picks how reports look.</span>
        <a href="/setup" className="font-medium text-agent-700 underline-offset-2 hover:underline dark:text-agent-300">
          Set up pr-report
        </a>
        <button type="button" onClick={dismiss} title="Not now" className="ml-auto rounded-control p-1 text-muted hover:bg-zinc-500/10">
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
};
