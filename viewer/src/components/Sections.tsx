import { ChevronRight, CircleHelp, Layers, MessageSquareReply } from "lucide-react";
import type { CommentTarget, Section } from "../../../skill/schema/types";
import { useAgent } from "../lib/agent";
import { HIGHLIGHTS, REVIEW, SECTIONS } from "../lib/meta";
import { targetKey, useReview } from "../lib/review";
import { sectionDomId, useReport } from "../lib/state";
import { commentButtonClass, QuickActions, SuggestedFix, TargetComments } from "./Comments";
import { FileCard } from "./FileCard";
import { RichText } from "./RichText";
import { SchemaDiagram } from "./SchemaDiagram";
import { cx, LocCount, Pill, RefLink, SectionTitle } from "./ui";
import { useChangeWords } from "../lib/pr";

const QuestionItem = ({ target, id }: { target: Extract<CommentTarget, { type: "question" }>; id: string }) => {
  const { editable, commentsFor, openComposer, composer } = useReview();
  const agent = useAgent();
  const answered = commentsFor(target).length > 0 || composer?.key === targetKey(target);
  return (
    <li id={id}>
      <RichText text={target.text} />
      {editable && !answered && (
        <button type="button" className={cx(commentButtonClass, "ml-1")} onClick={() => openComposer(target, { kind: "decision" })}>
          <MessageSquareReply className="size-3.5" /> Answer
        </button>
      )}
      <TargetComments target={target} placeholder={`Your answer. ${agent.Name} applies it as a decision.`} />
    </li>
  );
};

const SectionCard = ({ section, index, paths }: { section: Section; index: number; paths: string[] }) => {
  const { filesByPath, isSectionOpen, setSectionOpen, isViewed } = useReport();
  const words = useChangeWords();
  const open = isSectionOpen(index);
  const meta = SECTIONS[section.kind];
  const review = REVIEW[section.review];
  const Icon = meta.icon;

  const shown = section.files.filter((f) => paths.includes(f.path));
  const files = shown.map((f) => filesByPath.get(f.path)!);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const viewed = files.filter((f) => isViewed(f.path)).length;

  // The review level colors the card's left border, top to bottom, readable while scrolling
  // past. A border and not a strip laid inside the card: a strip needs the card to clip its content, and a card that
  // clips stops the file headers inside it from sticking under the top bar.
  return (
    <section id={sectionDomId(index)} className={cx("surface border border-l-[3px]", review.edge)}>
      <button
        type="button"
        onClick={() => setSectionOpen(index, !open)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-500/[0.04] sm:px-5"
      >
        <ChevronRight className={cx("mt-0.5 size-4 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <Icon className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-semibold">{section.title ?? meta.label}</span>
            <Pill className={cx("text-[11px]", review.className)}>{review.label}</Pill>
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-muted">{section.reason}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3 pt-0.5 text-xs text-muted">
          <span>
            <span className="num">{files.length}</span> {files.length === 1 ? "file" : "files"}
          </span>
          <LocCount additions={additions} deletions={deletions} />
          <span className={cx(viewed === files.length && "text-ok-600 dark:text-ok-400")}>
            <span className="num">
              {viewed}/{files.length}
            </span>{" "}
            viewed
          </span>
        </span>
      </button>

      {open && (
        <div className="rise space-y-5 border-t border-[var(--border)] px-3 pt-4 pb-4 sm:px-5">
          {section.kind === "database" && <SchemaDiagram />}

          {section.highlights.length > 0 && (
            <ul className="space-y-1">
              {section.highlights.map((h, i) => {
                const hm = HIGHLIGHTS[h.kind];
                const HIcon = hm.icon;
                const target: CommentTarget = { type: "highlight", section: section.kind, index: i, kind: h.kind, text: h.text, fix: h.fix };
                return (
                  <li key={i} id={`hl-${index}-${i}`} className="group/row relative flex flex-wrap items-start gap-x-3 gap-y-1 rounded-control px-2 py-2 hover:bg-zinc-500/[0.04]">
                    <span className={cx("label-caps inline-flex w-[94px] shrink-0 items-center gap-1.5 text-[11px]", hm.className)}>
                      <span className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-control", hm.tint)}>
                        <HIcon className="size-3.5" />
                      </span>
                      {hm.label}
                    </span>
                    <div className="min-w-[min(10rem,100%)] flex-1">
                      <RichText text={h.text} className="block text-sm leading-relaxed" />
                      {h.fix && <SuggestedFix text={h.fix} className="mt-1" />}
                      <QuickActions target={target} variant={h.kind === "risk" || h.kind === "gap" ? "problem" : "info"} />
                      <TargetComments target={target} />
                    </div>
                    {h.ref && <RefLink refTo={h.ref} className="ml-auto" />}
                  </li>
                );
              })}
            </ul>
          )}

          {section.questions.length > 0 && (
            <div className="rounded-control border border-agent-500/25 bg-agent-500/[0.05] px-3 py-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-agent-700 dark:text-agent-300">
                <CircleHelp className="size-3.5" />
                Answer before you open the {words.short}
              </p>
              <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed marker:text-agent-400">
                {section.questions.map((q, i) => (
                  <QuestionItem key={i} id={`q-${index}-${i}`} target={{ type: "question", section: section.kind, index: i, text: q }} />
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-3">
            {shown.map((f) => (
              <FileCard key={f.path} sectionFile={f} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

// Later rounds show the whole branch or only what changed since the round the reviewer sent.
export const ViewSwitch = () => {
  const { view, setView, sinceRound, bundle } = useReport();
  if (!sinceRound) return null;
  const options = [
    { value: "round", label: `Since round ${sinceRound.round}`, count: sinceRound.paths.size },
    { value: "branch", label: "Whole branch", count: bundle.diff.files.length },
  ] as const;
  return (
    <div className="inline-flex rounded-control border border-[var(--border)] p-0.5 text-xs" role="radiogroup" aria-label="Which changes to show">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={view === o.value}
          onClick={() => setView(o.value)}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 font-medium",
            view === o.value ? "bg-zinc-500/15 text-zinc-900 dark:text-zinc-100" : "text-muted hover:text-zinc-700 dark:hover:text-zinc-300",
          )}
        >
          {o.label}
          <span className="num text-faint">{o.count}</span>
        </button>
      ))}
    </div>
  );
};

export const Sections = () => {
  const { bundle, shownSections, view, sinceRound, setView } = useReport();
  const hidden = bundle.report.sections.length - shownSections.filter((s) => s.index < bundle.report.sections.length).length;
  return (
    <div id="changes">
      <SectionTitle right={<ViewSwitch />}>
        <span className="inline-flex items-center gap-2">
          <Layers className="size-4" /> Changes, in review order
        </span>
      </SectionTitle>
      {view === "round" && sinceRound && (
        <p className="mb-3 text-sm text-muted">
          Each file against its version in round {sinceRound.round}.
          {hidden > 0 && (
            <>
              {" "}
              {hidden} {hidden === 1 ? "section has" : "sections have"} no changes since then;{" "}
              <button type="button" onClick={() => setView("branch")} className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
                show the whole branch
              </button>
              .
            </>
          )}
        </p>
      )}
      {view === "round" && sinceRound && !sinceRound.paths.size && <p className="text-sm text-muted">No code changed since round {sinceRound.round}.</p>}
      <div className="space-y-3">
        {shownSections.map(({ section, index, paths }) => (
          <SectionCard key={`${view}-${section.kind}-${index}`} section={section} index={index} paths={paths} />
        ))}
      </div>
    </div>
  );
};
