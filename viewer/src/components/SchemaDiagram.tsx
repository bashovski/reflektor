import { KeyRound, Link2, Sheet } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SchemaStatus, SchemaTable } from "../../../skill/schema/types";
import { useReport } from "../lib/state";
import { cx, Pill, RefLink } from "./ui";

const STATUS: Record<SchemaStatus, { label: string; pill: string; row: string }> = {
  new: { label: "New", pill: "bg-ok-500/10 text-ok-700 ring-ok-500/30 dark:text-ok-300", row: "bg-ok-500/[0.07]" },
  changed: { label: "Changed", pill: "bg-warn-500/10 text-warn-700 ring-warn-500/30 dark:text-warn-300", row: "bg-warn-500/[0.07]" },
  removed: { label: "Removed", pill: "bg-danger-500/10 text-danger-700 ring-danger-500/30 dark:text-danger-300", row: "bg-danger-500/[0.07] line-through" },
  existing: { label: "Existing", pill: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-400", row: "text-zinc-500" },
};

type Line = { key: string; d: string; enforced: boolean; end: { x: number; y: number } };

const TableCard = ({ table, register }: { table: SchemaTable; register: (key: string, el: HTMLElement | null) => void }) => (
  <div className={cx("overflow-hidden rounded-control border bg-[var(--surface)]", table.status === "existing" ? "border-dashed border-zinc-400/50" : "border-[var(--border)]")}>
    <div ref={(el) => register(`${table.name}.`, el)} className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5">
      <Sheet className="size-3.5 text-zinc-500" />
      <span className="font-mono text-[13px] font-semibold">{table.name}</span>
      <Pill className={cx("px-1.5 py-0 text-[10px]", STATUS[table.status].pill)}>{STATUS[table.status].label}</Pill>
      {table.ref && (
        <span className="ml-auto">
          <RefLink refTo={table.ref} />
        </span>
      )}
    </div>
    <ul>
      {table.columns.map((c) => (
        <li
          key={c.name}
          ref={(el) => register(`${table.name}.${c.name}`, el)}
          className={cx("flex items-center gap-2 px-3 py-1 font-mono text-xs", STATUS[c.status].row)}
        >
          <span className="w-3.5 shrink-0">
            {c.key === "pk" ? <KeyRound className="size-3 text-warn-500" /> : c.references ? <Link2 className="size-3 text-accent-500" /> : null}
          </span>
          <span className="font-medium">{c.name}</span>
          <span className="text-zinc-500">{c.type}</span>
          {c.key === "unique" && <span className="font-sans text-[10px] text-zinc-500">unique</span>}
          {c.note && <span className={cx("ml-auto font-sans text-[11px]", c.enforced === false ? "text-danger-600 dark:text-danger-400" : "text-zinc-500")}>{c.note}</span>}
        </li>
      ))}
    </ul>
  </div>
);

// Tables touched by the change on the left, existing tables they point to on the right, and a line per relation.
// Dashed red lines are relations without a real foreign key.
export const SchemaDiagram = () => {
  const { bundle } = useReport();
  const tables = bundle.report.schema?.tables ?? [];
  const container = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<Line[]>([]);

  const register = (key: string, el: HTMLElement | null) => {
    if (el) elements.current.set(key, el);
    else elements.current.delete(key);
  };

  useLayoutEffect(() => {
    const measure = () => {
      const box = container.current?.getBoundingClientRect();
      if (!box) return;
      const next: Line[] = [];
      for (const t of tables) {
        for (const c of t.columns) {
          if (!c.references) continue;
          const [toTable, toColumn] = c.references.split(".");
          const from = elements.current.get(`${t.name}.${c.name}`);
          const to = elements.current.get(`${toTable}.${toColumn}`) ?? elements.current.get(`${toTable}.`);
          if (!from || !to) continue;
          const a = from.getBoundingClientRect();
          const b = to.getBoundingClientRect();
          const x1 = a.right - box.left;
          const y1 = a.top + a.height / 2 - box.top;
          const rightward = b.left > a.right - 2;
          const x2 = (rightward ? b.left : b.right) - box.left;
          const y2 = b.top + b.height / 2 - box.top;
          const bend = rightward ? Math.max(40, (x2 - x1) / 2) : 48;
          const d = rightward ? `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`;
          next.push({ key: `${t.name}.${c.name}`, d, enforced: c.enforced !== false, end: { x: x2, y: y2 } });
        }
      }
      setLines(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [tables]);

  if (!tables.length) return null;
  const touched = tables.filter((t) => t.status !== "existing");
  const existing = tables.filter((t) => t.status === "existing");

  return (
    <div className="rounded-control border border-[var(--border)] bg-[var(--bg)] p-4">
      <div ref={container} className="relative grid gap-x-20 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="space-y-4">
          {touched.map((t) => (
            <TableCard key={t.name} table={t} register={register} />
          ))}
        </div>
        <div className="space-y-4 self-center">
          {existing.map((t) => (
            <TableCard key={t.name} table={t} register={register} />
          ))}
        </div>
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {lines.map((l) => (
            <g key={l.key} className={l.enforced ? "text-zinc-400" : "text-danger-500"}>
              <path d={l.d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={l.enforced ? undefined : "5 4"} />
              <circle cx={l.end.x} cy={l.end.y} r={3} fill="currentColor" />
            </g>
          ))}
        </svg>
      </div>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 bg-zinc-400" /> foreign key
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t border-dashed border-danger-500" /> points to a table without a foreign key
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-control bg-ok-500/30" /> new
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-control bg-warn-500/30" /> changed
        </span>
      </p>
    </div>
  );
};
