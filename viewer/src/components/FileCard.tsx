import type { FileContents } from "@pierre/diffs";
import { type DiffLineAnnotation, type FileDiffOptions, MultiFileDiff, type SelectedLineRange } from "@pierre/diffs/react";
import { ChevronRight, FlaskConical, Maximize2, MessageSquarePlus, MessageSquareText, ShieldAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CommentTarget, DiffFile, Finding, SectionFile } from "../../../skill/schema/types";
import { FILE_STATUS, SEVERITY } from "../lib/meta";
import { useReview } from "../lib/review";
import { fileDomId, useReport } from "../lib/state";
import { CommentItem, Composer, TargetComments } from "./Comments";
import { RichText } from "./RichText";
import { cx, DiffBar, FileIcon, IconButton, LocCount, Pill } from "./ui";

type LineTarget = Extract<CommentTarget, { type: "line" }>;

// What a line annotation shows: Claude's note, a review comment, or the open comment box.
export type AnnotationMeta =
  | { type: "note"; text: string }
  | { type: "finding"; finding: Finding }
  | { type: "comment"; id: string }
  | { type: "composer"; target: LineTarget };

const LineComment = ({ id }: { id: string }) => {
  const { comments } = useReview();
  const comment = comments.find((c) => c.id === id);
  return comment ? (
    <div className="mr-3 ml-12 max-w-2xl">
      <CommentItem comment={comment} />
    </div>
  ) : null;
};

export const DIFF_THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

export type DiffInput =
  | { oldFile: FileContents; newFile: FileContents }
  | { oldFile: null; newFile: FileContents }
  | { oldFile: FileContents; newFile: null };

export const toDiffInput = (file: DiffFile): DiffInput | null => {
  const oldFile = file.oldContent == null ? null : { name: file.oldPath ?? file.path, contents: file.oldContent };
  const newFile = file.newContent == null ? null : { name: file.path, contents: file.newContent };
  if (oldFile && newFile) return { oldFile, newFile };
  if (newFile) return { oldFile: null, newFile };
  if (oldFile) return { oldFile, newFile: null };
  return null;
};

export const LineNoteBubble = ({ text }: { text: string }) => (
  <div className="my-1.5 mr-3 ml-12 flex max-w-2xl items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-50 px-3 py-2 font-sans text-[13px] leading-snug text-zinc-800 shadow-sm dark:bg-blue-950/60 dark:text-zinc-200">
    <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-blue-500" />
    <RichText text={text} />
  </div>
);

const FindingBubble = ({ finding }: { finding: Finding }) => (
  <div className={cx("my-1.5 mr-3 ml-12 flex max-w-2xl items-start gap-2 rounded-lg border bg-[var(--surface)] px-3 py-2 font-sans text-[13px] leading-snug shadow-sm", SEVERITY[finding.severity].border)}>
    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-red-500" />
    <span>
      {finding.kind === "secret" && <span className="font-semibold">{finding.rule}. </span>}
      {finding.message}
    </span>
  </div>
);

// Groups line numbers into ranges: [3,4,5,9] -> "3-5, 9"
const formatRanges = (lines: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out;
};

const CoveragePill = ({ covered, uncovered }: { covered: number; uncovered: number }) => {
  const total = covered + uncovered;
  const pct = Math.round((covered / total) * 100);
  const tone =
    pct === 100
      ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300"
      : pct >= 60
        ? "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300"
        : "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300";
  return (
    <Pill className={cx("hidden px-2 text-[11px] sm:inline-flex", tone)}>
      <FlaskConical className="size-3" />
      {covered}/{total} tested
    </Pill>
  );
};

export const FileCard = ({ sectionFile }: { sectionFile: SectionFile }) => {
  const { filesByPath, bundle, diffStyle, resolvedTheme, isViewed, toggleViewed, isFileOpen, setFileOpen, current, setCurrent, focus, openModal } =
    useReport();
  const file = filesByPath.get(sectionFile.path)!;
  const path = file.path;
  const viewed = isViewed(path);
  const open = isFileOpen(path);
  const coverage = bundle.diff.coverage?.files[path];
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);

  const input = useMemo(() => toDiffInput(file), [file]);

  const { comments, composer, openComposer, editable } = useReview();
  const fileTarget = useMemo<CommentTarget>(() => ({ type: "file", path }), [path]);

  const annotations = useMemo<DiffLineAnnotation<AnnotationMeta>[]>(() => {
    const list: DiffLineAnnotation<AnnotationMeta>[] = (sectionFile.lineNotes ?? []).map((n) => ({
      side: n.side === "old" ? "deletions" : "additions",
      lineNumber: n.line,
      metadata: { type: "note", text: n.text },
    }));
    for (const finding of bundle.diff.findings ?? []) {
      if (finding.path === path && finding.line) list.push({ side: "additions", lineNumber: finding.line, metadata: { type: "finding", finding } });
    }
    for (const c of comments) {
      if (c.target.type !== "line" || c.target.path !== path) continue;
      list.push({ side: c.target.side === "old" ? "deletions" : "additions", lineNumber: c.target.end, metadata: { type: "comment", id: c.id } });
    }
    if (composer?.target.type === "line" && composer.target.path === path && !composer.editingId) {
      const t = composer.target;
      list.push({ side: t.side === "old" ? "deletions" : "additions", lineNumber: t.end, metadata: { type: "composer", target: t } });
    }
    return list;
  }, [sectionFile, comments, composer, path, bundle]);

  // A ref keeps the diff options stable while the click handler sees fresh state.
  const onGutter = useRef<(range: SelectedLineRange) => void>(() => {});
  onGutter.current = (range) => {
    const side = range.side === "deletions" ? "old" : "new";
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    const content = (side === "old" ? file.oldContent : file.newContent) ?? "";
    const code = content.split("\n").slice(start - 1, end).join("\n");
    openComposer({ type: "line", path, side, start, end, code });
  };

  const uncoveredCss = useMemo(() => {
    if (!coverage?.uncovered.length) return "";
    const selectors = coverage.uncovered.map((l) => `[data-line-type="change-addition"][data-column-number="${l}"]`).join(",\n");
    return `${selectors} { box-shadow: inset -3px 0 0 rgb(239 68 68 / 0.85); }`;
  }, [coverage]);

  const options = useMemo<FileDiffOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: DIFF_THEME,
      themeType: resolvedTheme,
      diffStyle,
      disableFileHeader: true,
      hunkSeparators: "line-info",
      expansionLineCount: 20,
      lineDiffType: "word-alt",
      unsafeCSS: uncoveredCss,
      enableGutterUtility: editable,
      onGutterUtilityClick: (range: SelectedLineRange) => onGutter.current(range),
    }),
    [resolvedTheme, diffStyle, uncoveredCss, editable],
  );

  const focused = focus?.path === path && focus.line ? focus : null;
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (selected) return selected;
    if (!focused?.line) return null;
    const side = focused.side === "old" ? "deletions" : "additions";
    return { start: focused.line, end: focused.line, side };
  }, [focused, selected]);

  const renderAnnotation = useCallback((a: DiffLineAnnotation<AnnotationMeta>) => {
    const m = a.metadata;
    if (m.type === "note") return <LineNoteBubble text={m.text} />;
    if (m.type === "finding") return <FindingBubble finding={m.finding} />;
    if (m.type === "comment") return <LineComment id={m.id} />;
    return (
      <div className="mr-3 ml-12 max-w-2xl">
        <Composer target={m.target} />
      </div>
    );
  }, []);

  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const status = FILE_STATUS[file.status];

  return (
    <div
      id={fileDomId(path)}
      onClickCapture={() => setCurrent(path)}
      className={cx("surface overflow-clip rounded-lg border", current === path && "ring-2 ring-blue-500/40")}
    >
      <div className={cx("sticky top-14 z-10 flex items-center gap-2 bg-[var(--surface-2)] px-2 py-1.5 sm:px-3", open && "border-b border-[var(--border)]")}>
        <button type="button" onClick={() => setFileOpen(path, !open)} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-500/10" title={open ? "Collapse" : "Expand"}>
          <ChevronRight className={cx("size-4 transition-transform", open && "rotate-90")} />
        </button>
        <span className={cx("w-14 shrink-0 text-[11px] font-medium", status.className)}>{status.label}</span>
        <FileIcon path={path} />
        <button type="button" onClick={() => setFileOpen(path, !open)} className="flex min-w-0 text-left font-mono text-[12.5px]" title={path}>
          <span className="truncate text-zinc-500">{dir}</span>
          <span className="shrink-0 font-semibold">{name}</span>
          {file.oldPath && <span className="truncate text-zinc-400">&nbsp;(from {file.oldPath})</span>}
        </button>
        {file.uncommitted && <Pill className="shrink-0 bg-amber-500/10 px-2 text-[10px] text-amber-700 ring-amber-500/30 dark:text-amber-300">Not committed</Pill>}
        {file.generated && <Pill className="shrink-0 bg-zinc-500/10 px-2 text-[10px] text-zinc-500 ring-zinc-500/25">Generated</Pill>}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {coverage && coverage.covered.length + coverage.uncovered.length > 0 && <CoveragePill covered={coverage.covered.length} uncovered={coverage.uncovered.length} />}
          <span className="hidden items-center gap-2 sm:inline-flex">
            <LocCount additions={file.additions} deletions={file.deletions} />
            <DiffBar additions={file.additions} deletions={file.deletions} />
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-zinc-600 select-none hover:bg-zinc-500/5 dark:text-zinc-400">
            <input type="checkbox" checked={viewed} onChange={() => toggleViewed(path)} className="size-3.5 accent-blue-600" />
            Viewed
          </label>
          {editable && (
            <IconButton
              title="Comment on the whole file. For one line, hover a line number and click +."
              onClick={() => {
                setFileOpen(path, true);
                openComposer(fileTarget);
              }}
            >
              <MessageSquarePlus className="size-3.5" />
            </IconButton>
          )}
          <IconButton title="Show the full file (f)" onClick={() => openModal({ path })} disabled={!input}>
            <Maximize2 className="size-3.5" />
          </IconButton>
        </div>
      </div>

      {open && (
        <>
          {sectionFile.note && (
            <div className="flex gap-3 border-b border-[var(--border)] bg-blue-500/[0.04] px-4 py-3">
              <MessageSquareText className="mt-0.5 size-4 shrink-0 text-blue-500" />
              <RichText text={sectionFile.note} className="block max-w-3xl text-[13.5px] leading-relaxed text-zinc-700 dark:text-zinc-300" />
            </div>
          )}
          <div className="px-3 empty:hidden [&>*]:mb-2">
            <TargetComments target={fileTarget} placeholder="A comment about this whole file" />
          </div>
          {coverage && coverage.uncovered.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400">
                <span className="h-3 w-[3px] rounded-full bg-red-500" />
                Tests never run new lines
              </span>
              {formatRanges(coverage.uncovered).map((r) => {
                const [start, end = start] = r.split("-").map(Number);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setSelected({ start, end, side: "additions" })}
                    className="rounded bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[11px] hover:bg-zinc-500/20"
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          )}
          {!input ? (
            <p className="px-4 py-6 text-sm text-zinc-500">{file.binary ? "Binary file. Not shown." : "File is too large to show here."}</p>
          ) : (
            <MultiFileDiff<AnnotationMeta>
              {...input}
              options={options}
              lineAnnotations={annotations}
              renderAnnotation={renderAnnotation}
              selectedLines={selectedLines}
            />
          )}
        </>
      )}
    </div>
  );
};
