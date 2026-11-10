import { Braces, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Contract, ContractKind, ContractStatus, MemberChange } from "../../../skill/schema/types";
import { useReport } from "../lib/state";
import { RichText } from "./RichText";
import { Card, cx, Pill, RefLink, SectionTitle } from "./ui";

// Types, interfaces, enums and exported constants the change adds, changes or removes.
// Collapsed by default, like the flows and sections.

const KIND: Record<ContractKind, string> = { type: "type", interface: "interface", enum: "enum", constant: "const" };

const STATUS: Record<ContractStatus, { label: string; pill: string }> = {
  new: { label: "New", pill: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
  changed: { label: "Changed", pill: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300" },
  removed: { label: "Removed", pill: "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300" },
};

const MEMBER: Record<MemberChange, { sign: string; className: string }> = {
  added: { sign: "+", className: "text-emerald-600 dark:text-emerald-400" },
  removed: { sign: "−", className: "text-red-600 dark:text-red-400" },
  changed: { sign: "~", className: "text-amber-600 dark:text-amber-400" },
};

const ContractRow = ({ contract: c }: { contract: Contract }) => (
  <li className="px-4 py-3 sm:px-5">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="w-16 shrink-0 font-mono text-[11px] text-zinc-500">{KIND[c.kind]}</span>
      <code className="font-mono text-[13px] font-semibold">{c.name}</code>
      <Pill className={cx("px-1.5 py-0 text-[10px]", STATUS[c.status].pill)}>{STATUS[c.status].label}</Pill>
      {c.generated && (
        <Pill className="bg-zinc-500/10 px-1.5 py-0 text-[10px] text-zinc-500 ring-zinc-500/25">
          <span title="Generated code: review the schema or spec it is generated from">Generated</span>
        </Pill>
      )}
      <span className="ml-auto">
        <RefLink refTo={c.ref} keep={2} />
      </span>
    </div>
    {c.note && <RichText text={c.note} className="mt-1 block text-sm leading-relaxed text-zinc-600 sm:pl-[72px] dark:text-zinc-400" />}
    {c.kind === "constant" && (c.value || c.was) && (
      <div className="mt-1.5 font-mono text-xs sm:pl-[72px]">
        {c.was && <span className={cx("text-red-600 dark:text-red-400", c.value && "line-through decoration-red-400/50")}>{c.was}</span>}
        {c.was && c.value && <span className="px-1.5 text-zinc-400">→</span>}
        {c.value && <span className="text-emerald-700 dark:text-emerald-400">{c.value}</span>}
      </div>
    )}
    {!!c.members?.length && (
      <ul className="mt-2 rounded-control bg-zinc-500/[0.06] px-3 py-1.5 font-mono text-xs leading-relaxed sm:ml-[72px]">
        {c.members.map((m) => (
          <li key={`${m.change}-${m.name}`} className="flex gap-2">
            <span className={cx("w-2.5 shrink-0 font-semibold", MEMBER[m.change].className)}>{MEMBER[m.change].sign}</span>
            <span className={cx(m.change === "removed" && "text-zinc-500 line-through decoration-red-400/50")}>
              {m.name}
              {m.type && (
                <span className="text-zinc-500">
                  : {m.was && <span className="text-red-600 line-through decoration-red-400/50 dark:text-red-400">{m.was}</span>}
                  {m.was && <span className="px-1 text-zinc-400">→</span>}
                  {m.type}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    )}
  </li>
);

export const Contracts = () => {
  const { bundle } = useReport();
  const [open, setOpen] = useState(false);
  const contracts = bundle.report.contracts ?? [];
  if (!contracts.length) return null;
  const counts = (["new", "changed", "removed"] as const)
    .map((s) => [contracts.filter((c) => c.status === s).length, STATUS[s].label.toLowerCase()] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");

  return (
    <div id="contracts">
      <SectionTitle>
        <span className="inline-flex items-center gap-2">
          <Braces className="size-4" /> Types and contracts
        </span>
      </SectionTitle>
      <Card className="overflow-hidden">
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-zinc-500/[0.04] sm:px-5">
          <ChevronRight className={cx("size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
          <span className="font-semibold">
            {contracts.length} {contracts.length === 1 ? "type or constant" : "types and constants"}
          </span>
          <span className="text-xs text-zinc-500">{counts}</span>
        </button>
        {open && (
          <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {contracts.map((c, i) => (
              <ContractRow key={i} contract={c} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
