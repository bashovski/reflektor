import { FileText } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useMemo } from "react";
import type { Ref } from "../../../skill/schema/types";
import { useReport } from "../lib/state";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export const Pill = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", className)}>
    {children}
  </span>
);

export const Dot = ({ className }: { className: string }) => <span className={cx("size-1.5 shrink-0 rounded-full", className)} />;

export const LocCount = ({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) => (
  <span className={cx("font-mono text-xs tabular-nums", className)}>
    <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
    <span className="text-red-600 dark:text-red-400">−{deletions}</span>
  </span>
);

export const DiffBar = ({ additions, deletions }: { additions: number; deletions: number }) => {
  const total = additions + deletions;
  const green = total ? Math.round((additions / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.round((deletions / total) * 5)) : 0;
  return (
    <span className="inline-flex gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cx(
            "size-2 rounded-[2px]",
            i < green ? "bg-emerald-500" : i < green + red ? "bg-red-500" : "bg-zinc-300 dark:bg-zinc-700",
          )}
        />
      ))}
    </span>
  );
};

// File type icon from the report's embedded icon set. Loaded as an <img>, so the SVG cannot run anything.
export const FileIcon = ({ path, className }: { path: string; className?: string }) => {
  const { bundle } = useReport();
  const svg = bundle.fileIcons ? bundle.fileIcons.icons[bundle.fileIcons.byPath[path]] : undefined;
  const src = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg]);
  if (!src) return <FileText className={cx("size-4 shrink-0 text-zinc-400", className)} aria-hidden />;
  return <img src={src} alt="" aria-hidden className={cx("size-4 shrink-0", className)} />;
};

export const shortPath = (path: string, keep = 2) => {
  const parts = path.split("/");
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
};

export const RefLink = ({ refTo, keep = 1 }: { refTo: Ref; keep?: number }) => {
  const { jumpTo } = useReport();
  return (
    <button
      type="button"
      onClick={() => jumpTo(refTo)}
      title={`${refTo.path}${refTo.line ? `:${refTo.line}` : ""}`}
      className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] text-zinc-500 hover:bg-zinc-500/10 hover:text-zinc-900 dark:hover:text-zinc-100"
    >
      {shortPath(refTo.path, keep)}
      {refTo.line ? `:${refTo.line}` : ""}
    </button>
  );
};

export const IconButton = ({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className={cx(
      "inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

export const Card = ({ className, children, id }: { className?: string; children: ReactNode; id?: string }) => (
  <section id={id} className={cx("surface rounded-xl border", className)}>
    {children}
  </section>
);

export const SectionTitle = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="mb-3 flex items-end justify-between gap-4">
    <h2 className="text-[13px] font-semibold uppercase tracking-wide text-zinc-500">{children}</h2>
    {right}
  </div>
);
