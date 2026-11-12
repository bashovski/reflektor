import { FileText } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useMemo } from "react";
import logoSvg from "../../../skill/brand/reflektor-logo.svg?raw";
import type { Ref, RepoAvatar, Tag } from "../../../skill/schema/types";
import { TAGS } from "../lib/meta";
import { useReport } from "../lib/state";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// A badge: a short status or kind, in the label style (see `label-caps` in index.css).
export const Pill = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cx("label-caps inline-flex items-center gap-1.5 rounded-control px-2.5 py-0.5 text-xs ring-1 ring-inset", className)}>
    {children}
  </span>
);

export const Dot = ({ className }: { className: string }) => <span className={cx("size-1.5 shrink-0 rounded-full", className)} />;

// A meter: how much of something is done. A row of square cells and not one round bar, so it reads as a count:
// one cell for each thing while there are few (the files of a section, the items of a plan), and at most
// METER_CELLS when there are many. A cell can be part full, so the filled length stays exact either way.
// `fill` is the color of the filled part, and `className` gives the height and the width. The number is
// always written next to a meter, so screen readers skip the drawing.
const METER_CELLS = 24;
export const Meter = ({ value, total, cells, fill, className }: { value: number; total: number; cells?: number; fill: string; className?: string }) => {
  const count = cells ?? Math.max(1, Math.min(total, METER_CELLS));
  const filled = total > 0 ? Math.min(1, Math.max(0, value / total)) * count : 0;
  return (
    <span aria-hidden className={cx("flex gap-0.5", className)}>
      {Array.from({ length: count }, (_, i) => {
        const part = Math.min(1, Math.max(0, filled - i));
        return (
          <span key={i} className="h-full min-w-0 flex-1 bg-zinc-500/15">
            {part > 0 && <span className={cx("block h-full transition-all", fill)} style={{ width: `${part * 100}%` }} />}
          </span>
        );
      })}
    </span>
  );
};

// A number inside a small mark. Centering the line of text leaves the digit about a pixel high, because a
// line keeps room under the baseline for descenders, and a digit has none. `text-box` cuts the line down to
// the digit itself, from the top of a capital to the baseline, so the mark centers what the eye sees. Where a
// browser does not know `text-box` yet, the digit stays where it was.
export const Digit = ({ children }: { children: ReactNode }) => <span className="num leading-none [text-box:trim-both_cap_alphabetic]">{children}</span>;

// A small ring filled to `value` (0 to 1): how much of the review is viewed, in the top bar.
export const ProgressRing = ({ value, className }: { value: number; className?: string }) => {
  const r = 7;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg viewBox="0 0 18 18" className={cx("shrink-0 -rotate-90", className)} aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-zinc-500/20" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        className={cx("transition-[stroke-dashoffset] duration-300", v >= 1 ? "stroke-ok-500" : "stroke-accent")}
      />
    </svg>
  );
};

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

// The modifier that pairs with Enter in shortcuts: Cmd on a Mac, Ctrl everywhere else.
export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Meta" : "Control";

// The Reflektor mark: a pixel "r" with a soft shape in the four brand colors. The file is skill/brand/reflektor-logo.svg,
// the one the inbox reads too. It is put into the page as SVG and not as an image, because the letter is drawn in
// the current text color: white in the dark theme, near-black in the light one. The height comes from `className`
// and the width follows. With a `label` it is announced as an image; without one it is decoration next to a name.
export const Logo = ({ label, className }: { label?: string; className?: string }) => (
  <span
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    className={cx("inline-block shrink-0 text-accent [&>svg]:block [&>svg]:h-full [&>svg]:w-auto", className)}
    dangerouslySetInnerHTML={{ __html: logoSvg }}
  />
);

// A key cap: a small rectangle with a hairline border and a one-pixel ledge under it, the way
// Linear draws shortcuts. `name` is the key as KeyboardEvent.key gives it ("Enter", "j", "?").
export const Kbd = ({ name, className }: { name: string; className?: string }) => (
  <kbd
    className={cx(
      "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-1.5 font-mono text-[11px] leading-none font-medium text-zinc-600 shadow-[0_1px_0_0_var(--border)] dark:text-zinc-300",
      className,
    )}
  >
    {KEY_LABELS[name] ?? name}
  </kbd>
);

// The PR type, drawn the same way as in the inbox (tagPill in skill/scripts/daemon.mts): a colored tag with a white icon.
export const TagPill = ({ tag, className }: { tag: Tag; className?: string }) => {
  const { color, icon: Icon } = TAGS[tag];
  return (
    <span
      className={cx("inline-flex h-[22px] items-center gap-[5px] rounded-control pr-[9px] pl-[7px] font-mono text-[11px] font-semibold tracking-[0.03em] whitespace-nowrap text-white", className)}
      style={{ background: color }}
    >
      <Icon className="size-3" strokeWidth={2.4} aria-hidden="true" />
      {tag}
    </span>
  );
};

export const LocCount = ({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) => (
  <span className={cx("num text-xs", className)}>
    <span className="text-ok-600 dark:text-ok-400">+{additions}</span>{" "}
    <span className="text-danger-600 dark:text-danger-400">−{deletions}</span>
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
            "size-2",
            i < green ? "bg-ok-500" : i < green + red ? "bg-danger-500" : "bg-zinc-300 dark:bg-zinc-700",
          )}
        />
      ))}
    </span>
  );
};

// File type icon from the report's embedded icon set. Loaded as an <img>, so the SVG cannot run anything.
// The size is a prop of its own and not part of `className`: two size classes on one element do not override each
// other by their order in the class list, so a second one passed there was ignored.
export const FileIcon = ({ path, size = "size-4", className }: { path: string; size?: string; className?: string }) => {
  const { bundle } = useReport();
  const svg = bundle.fileIcons ? bundle.fileIcons.icons[bundle.fileIcons.byPath[path]] : undefined;
  const src = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg]);
  if (!src) return <FileText className={cx(size, "shrink-0 text-faint", className)} aria-hidden />;
  return <img src={src} alt="" aria-hidden className={cx(size, "shrink-0", className)} />;
};

// The repo owner's picture, or its initials on a color. Square with slightly rounded corners.
export const OwnerAvatar = ({ avatar, className }: { avatar?: RepoAvatar; className?: string }) => {
  if (!avatar) return null;
  if (avatar.image) return <img src={avatar.image} alt="" aria-hidden className={cx("shrink-0 rounded-control object-cover", className)} />;
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-control font-semibold leading-none text-white", className)}
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

// A file reference chip: the file's icon, its path and the line. Every file link on the page is one of these, so a
// path you can click always shows what kind of file it is. It never shrinks next to text, so the rows that hold one
// wrap it to a line of its own on a narrow screen (flex-wrap on the row, a minimum width on the text). There it is at
// most as wide as the row: the path truncates, the icon and the line number never do. Without this, a long file name
// pushed the page wider than a phone screen.
export const RefLink = ({ refTo, keep = 1, className }: { refTo: Ref; keep?: number; className?: string }) => {
  const { jumpTo } = useReport();
  return (
    <button
      type="button"
      onClick={() => jumpTo(refTo)}
      title={`${refTo.path}${refTo.line ? `:${refTo.line}` : ""}`}
      className={cx(
        "inline-flex max-w-full min-w-0 shrink-0 items-center rounded-control px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-zinc-500/10 hover:text-zinc-900 dark:hover:text-zinc-100",
        className,
      )}
    >
      <FileIcon path={refTo.path} size="size-3.5" className="mr-1" />
      <span className="truncate">{shortPath(refTo.path, keep)}</span>
      {refTo.line ? <span className="shrink-0">:{refTo.line}</span> : null}
    </button>
  );
};

export const IconButton = ({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className={cx(
      "inline-flex items-center justify-center gap-1.5 rounded-control px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

// A block on the page. Its corners are square on purpose: see `.surface` in index.css.
export const Card = ({ className, children, id }: { className?: string; children: ReactNode; id?: string }) => (
  <section id={id} className={cx("surface border", className)}>
    {children}
  </section>
);

export const SectionTitle = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="mb-3 flex items-end justify-between gap-4">
    <h2 className="label-caps text-xs text-muted">{children}</h2>
    {right}
  </div>
);
