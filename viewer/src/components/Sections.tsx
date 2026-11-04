import { ChevronRight, CircleHelp, Layers } from "lucide-react";
import type { Section } from "../../../skill/schema/types";
import { HIGHLIGHTS, REVIEW, SECTIONS } from "../lib/meta";
import { sectionDomId, useReport } from "../lib/state";
import { FileCard } from "./FileCard";
import { RichText } from "./RichText";
import { cx, LocCount, Pill, RefLink, SectionTitle } from "./ui";

const SectionCard = ({ section, index }: { section: Section; index: number }) => {
  const { filesByPath, isSectionOpen, setSectionOpen, isViewed } = useReport();
  const open = isSectionOpen(index);
  const meta = SECTIONS[section.kind];
  const review = REVIEW[section.review];
  const Icon = meta.icon;

  const files = section.files.map((f) => filesByPath.get(f.path)!);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const viewed = files.filter((f) => isViewed(f.path)).length;

  return (
    <section id={sectionDomId(index)} className="surface rounded-xl border">
      <button
        type="button"
        onClick={() => setSectionOpen(index, !open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3.5 text-left hover:bg-zinc-500/[0.04] sm:px-5"
      >
        <ChevronRight className={cx("size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
        <Icon className="size-4 shrink-0 text-zinc-500" />
        <span className="font-semibold">{section.title ?? meta.label}</span>
        <Pill className={review.className}>{review.label}</Pill>
        <span className="hidden min-w-0 flex-1 truncate text-sm text-zinc-500 md:block">{section.reason}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <LocCount additions={additions} deletions={deletions} />
          <span className={cx("tabular-nums", viewed === files.length && "text-emerald-600 dark:text-emerald-400")}>
            {viewed}/{files.length} viewed
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-[var(--border)] px-3 pt-4 pb-4 sm:px-5">
          <p className="text-sm text-zinc-500 md:hidden">{section.reason}</p>

          {section.highlights.length > 0 && (
            <ul className="space-y-1">
              {section.highlights.map((h, i) => {
                const hm = HIGHLIGHTS[h.kind];
                const HIcon = hm.icon;
                return (
                  <li key={i} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-500/[0.04]">
                    <span className={cx("mt-[1px] inline-flex w-[86px] shrink-0 items-center gap-1.5 text-xs font-medium", hm.className)}>
                      <HIcon className="size-3.5" />
                      {hm.label}
                    </span>
                    <RichText text={h.text} className="block min-w-0 flex-1 text-sm leading-relaxed" />
                    {h.ref && <RefLink refTo={h.ref} />}
                  </li>
                );
              })}
            </ul>
          )}

          {section.questions.length > 0 && (
            <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.05] px-3 py-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
                <CircleHelp className="size-3.5" />
                Answer before you open the PR
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed marker:text-violet-400">
                {section.questions.map((q, i) => (
                  <li key={i}>
                    <RichText text={q} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-3">
            {section.files.map((f) => (
              <FileCard key={f.path} sectionFile={f} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export const Sections = () => {
  const { bundle } = useReport();
  return (
    <div id="changes">
      <SectionTitle>
        <span className="inline-flex items-center gap-2">
          <Layers className="size-4" /> Changes, in review order
        </span>
      </SectionTitle>
      <div className="space-y-3">
        {bundle.report.sections.map((s, i) => (
          <SectionCard key={`${s.kind}-${i}`} section={s} index={i} />
        ))}
      </div>
    </div>
  );
};
