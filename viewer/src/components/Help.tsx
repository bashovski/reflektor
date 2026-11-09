import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { PROJECT } from "../lib/meta";
import { SHORTCUTS } from "./Settings";

// How a review works, in the order a reviewer meets it. Opened from the user menu.
const STEPS: [string, string][] = [
  ["Read in the order the report suggests", "Must-read files first, then skim the rest. The sidebar keeps track of what you have viewed."],
  ["Comment on a line", "Hover a line number and click +, or press c for the current file. A general comment goes at the bottom of the page."],
  ["Decide on each risk", "“Fix this” tells Claude to make the suggested change. “It’s fine” accepts the risk, and later reports leave it alone."],
  ["Ask before deciding", "“Ask Claude now” gets an answer about the code without changing anything."],
  ["Send it", "“Send to Claude” hands your comments over. Claude posts a plan for you to approve, makes the changes, and publishes the next round here."],
];

export const HelpDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="surface m-auto w-[min(560px,94vw)] rounded-xl border p-0 text-[var(--text)] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <h2 className="font-semibold">Help</h2>
        <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-500/10" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-6 px-5 py-4">
        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-zinc-500">How to review</h3>
          <ol className="space-y-2.5 text-sm">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-zinc-500/10 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{i + 1}</span>
                <span>
                  <span className="font-medium">{title}</span> <span className="text-zinc-600 dark:text-zinc-400">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-zinc-500">Keyboard shortcuts</h3>
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {SHORTCUTS.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2.5">
                <kbd className="inline-flex min-w-6 justify-center rounded border border-[var(--border)] bg-zinc-500/10 px-1.5 font-mono text-xs">{key}</kbd>
                <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
              </li>
            ))}
          </ul>
        </section>

        <a href={PROJECT.readme} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline dark:text-blue-400">
          Read the README on GitHub <ExternalLink className="size-3.5" />
        </a>
      </div>
    </dialog>
  );
};
