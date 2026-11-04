import type { FileContents } from "@pierre/diffs";
import { File as CodeFile, type FileDiffOptions, type FileOptions, MultiFileDiff } from "@pierre/diffs/react";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useReport } from "../lib/state";
import { DIFF_THEME, toDiffInput } from "./FileCard";
import { cx, LocCount } from "./ui";

type Mode = "changes" | "file";

export const FileModal = () => {
  const { modal, openModal, filesByPath, bundle, resolvedTheme, diffStyle } = useReport();
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>("changes");

  const diffFile = modal ? filesByPath.get(modal.path) : undefined;
  const contextText = modal && !diffFile ? bundle.contextFiles[modal.path] : undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (modal && !dialog.open) dialog.showModal();
    if (!modal && dialog.open) dialog.close();
    setMode(diffFile ? "changes" : "file");
  }, [modal, diffFile]);

  const contents = useMemo(() => (diffFile ? toDiffInput(diffFile) : null), [diffFile]);
  const plainFile = useMemo<FileContents | null>(() => {
    if (!modal) return null;
    if (contextText != null) return { name: modal.path, contents: contextText };
    return contents?.newFile ?? contents?.oldFile ?? null;
  }, [modal, contextText, contents]);

  const diffOptions = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({ theme: DIFF_THEME, themeType: resolvedTheme, diffStyle, disableFileHeader: true, expandUnchanged: true }),
    [resolvedTheme, diffStyle],
  );
  const fileOptions = useMemo<FileOptions<undefined, undefined>>(
    () => ({ theme: DIFF_THEME, themeType: resolvedTheme, disableFileHeader: true }),
    [resolvedTheme],
  );

  const line = modal?.line;
  const side = modal?.side === "old" ? "deletions" : "additions";

  return (
    <dialog
      ref={ref}
      onClose={() => openModal(null)}
      onClick={(e) => e.target === ref.current && openModal(null)}
      className="surface m-auto h-[90vh] w-[min(1200px,94vw)] max-w-none overflow-hidden rounded-xl border p-0 text-[var(--text)] shadow-2xl"
    >
      {modal && (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
            <span className="min-w-0 truncate font-mono text-sm font-medium">{modal.path}</span>
            {diffFile && <LocCount additions={diffFile.additions} deletions={diffFile.deletions} />}
            {!diffFile && <span className="text-xs text-zinc-500">Not changed in this branch</span>}
            <div className="ml-auto flex items-center gap-2">
              {diffFile && plainFile && (
                <div className="inline-flex rounded-lg bg-zinc-500/10 p-0.5">
                  {(["changes", "file"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={cx(
                        "rounded-md px-2 py-1 text-xs font-medium",
                        mode === m ? "surface shadow-sm" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
                      )}
                    >
                      {m === "changes" ? "Changes in full file" : "Final file"}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => openModal(null)} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-500/10" title="Close (Esc)">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {mode === "changes" && contents ? (
              <MultiFileDiff
                {...contents}
                options={diffOptions}
                selectedLines={line ? { start: line, end: line, side } : null}
              />
            ) : plainFile ? (
              <CodeFile file={plainFile} options={fileOptions} selectedLines={line ? { start: line, end: line } : null} />
            ) : (
              <p className="p-6 text-sm text-zinc-500">This file is not included in the report.</p>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
};
