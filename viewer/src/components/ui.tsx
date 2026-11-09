import { FileText } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useMemo } from "react";
import type { Ref, RepoAvatar, Tag } from "../../../skill/schema/types";
import { TAGS } from "../lib/meta";
import { useReport } from "../lib/state";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export const Pill = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", className)}>
    {children}
  </span>
);

export const Dot = ({ className }: { className: string }) => <span className={cx("size-1.5 shrink-0 rounded-full", className)} />;

// What a key cap shows for keys whose name is not what the keyboard prints on them.
export const KEY_LABELS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Tab: "⇥",
  Shift: "⇧",
  Meta: "⌘",
  Control: "Ctrl",
  " ": "Space",
};

// A key cap: a small rounded rectangle with a hairline border and a one-pixel ledge under it, the way
// Linear draws shortcuts. `name` is the key as KeyboardEvent.key gives it ("Enter", "j", "?").
export const Kbd = ({ name, className }: { name: string; className?: string }) => (
  <kbd
    className={cx(
      "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[5px] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 font-mono text-[11px] leading-none font-medium text-zinc-600 shadow-[0_1px_0_0_var(--border)] dark:text-zinc-300",
      className,
    )}
  >
    {KEY_LABELS[name] ?? name}
  </kbd>
);

// The PR type, drawn the same way as in the inbox (tagPill in skill/scripts/daemon.mjs): a colored pill with a white icon.
export const TagPill = ({ tag, className }: { tag: Tag; className?: string }) => {
  const { color, icon: Icon } = TAGS[tag];
  return (
    <span
      className={cx("inline-flex h-[22px] items-center gap-[5px] rounded-full pr-[9px] pl-[7px] font-mono text-[11px] font-semibold tracking-[0.03em] whitespace-nowrap text-white", className)}
      style={{ background: color }}
    >
      <Icon className="size-3" strokeWidth={2.4} aria-hidden="true" />
      {tag}
    </span>
  );
};

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

// The repo owner's picture, or its initials on a color. Square with slightly rounded corners.
export const OwnerAvatar = ({ avatar, className }: { avatar?: RepoAvatar; className?: string }) => {
  if (!avatar) return null;
  if (avatar.image) return <img src={avatar.image} alt="" aria-hidden className={cx("shrink-0 rounded-md object-cover", className)} />;
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-md font-semibold leading-none text-white", className)}
      style={{ backgroundColor: avatar.color }}
    >
      {avatar.initials}
    </span>
  );
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
