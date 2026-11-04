import type { ReactNode } from "react";
import { cx } from "./ui";

// Renders the small Markdown subset report text may use:
// **bold**, `code`, "- item" bullet lines and "1. item" numbered lines.
// Builds React nodes only, so report text can never inject HTML.

type Block = { type: "p"; text: string } | { type: "ul" | "ol"; items: string[] };

const parseBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    const type = bullet ? "ul" : numbered ? "ol" : "p";
    const last = blocks.at(-1);
    if (type === "p") blocks.push({ type, text: line });
    else if (last && last.type === type) last.items.push((bullet ?? numbered)![1]);
    else blocks.push({ type, items: [(bullet ?? numbered)![1]] });
  }
  return blocks;
};

const renderInline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-zinc-900 dark:text-zinc-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-zinc-500/10 px-1 py-px font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });

export const RichText = ({ text, className }: { text: string; className?: string }) => {
  const blocks = parseBlocks(text);
  if (blocks.length === 1 && blocks[0].type === "p") return <span className={className}>{renderInline(blocks[0].text)}</span>;

  return (
    <div className={cx("space-y-1", className)}>
      {blocks.map((block, i) => {
        if (block.type === "p") return <p key={i}>{renderInline(block.text)}</p>;
        const List = block.type;
        return (
          <List key={i} className={cx("space-y-0.5 pl-5 marker:text-zinc-400", List === "ul" ? "list-disc" : "list-decimal")}>
            {block.items.map((item, j) => (
              <li key={j} className="pl-0.5">
                {renderInline(item)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
};
