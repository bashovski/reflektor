import { Check, ClipboardCopy, FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgent } from "../lib/agent";
import { useReport } from "../lib/state";

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
};

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await copyText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 2000);
      }}
      className="inline-flex items-center gap-1.5 rounded-control border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-zinc-500/10"
    >
      {done ? <Check className="size-3.5 text-ok-600" /> : <ClipboardCopy className="size-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
};

// The pull request title and body that build.mjs wrote from this report.
export const PrDescription = () => {
  const agent = useAgent();
  const { bundle } = useReport();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const pr = bundle.prDescription;

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  if (!pr) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 dark:text-zinc-400"
      >
        <FileText className="size-3.5" />
        PR description
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === ref.current && setOpen(false)}
        className="surface m-auto h-[min(80vh,760px)] w-[min(760px,94vw)] max-w-none overflow-hidden rounded-control border p-0 text-[var(--text)] shadow-float"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3">
            <h2 className="font-semibold">PR description</h2>
            <span className="text-xs text-zinc-500">Markdown, ready to paste. {agent.Name} can also open the PR with it.</span>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto rounded-control p-1 text-zinc-500 hover:bg-zinc-500/10" title="Close (Esc)">
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label-caps text-xs text-zinc-500">Title</span>
                <CopyButton text={pr.title} label="Copy title" />
              </div>
              <p className="rounded-control border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm">{pr.title}</p>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label-caps text-xs text-zinc-500">Body</span>
                <CopyButton text={pr.body} label="Copy body" />
              </div>
              <pre className="rounded-control border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">{pr.body}</pre>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
};
