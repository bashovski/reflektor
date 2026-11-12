import { ShieldAlert, ShieldCheck } from "lucide-react";
import { FINDING_KINDS, SEVERITY } from "../lib/meta";
import { useReport } from "../lib/state";
import { cx, Pill, RefLink } from "./ui";

// Results of the fixed safety rules in collect.mts: likely secrets and risky migrations.
export const Findings = () => {
  const { bundle } = useReport();
  const findings = bundle.diff.findings ?? [];

  if (!findings.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-ok-700 dark:text-ok-400">
        <ShieldCheck className="size-4" />
        Automatic checks found no likely secrets or risky migrations.
      </p>
    );
  }

  return (
    <section id="findings" className="surface border p-4 sm:p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert className="size-4 text-danger-500" />
        Automatic checks
      </h2>
      <p className="mb-3 text-xs text-muted">Fixed rules on the added lines, not AI. Secret values are masked.</p>
      <ul className="space-y-2.5">
        {findings.map((f, i) => {
          const kind = FINDING_KINDS[f.kind];
          const Icon = kind.icon;
          return (
            <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
              <Pill className={cx("mt-px w-16 shrink-0 justify-center px-2 py-0 text-[10px]", SEVERITY[f.severity].className)}>{SEVERITY[f.severity].label}</Pill>
              <div className="min-w-[min(10rem,100%)] flex-1">
                <p className="flex flex-wrap items-center gap-x-2 font-medium">
                  <Icon className="size-3.5 text-muted" />
                  {f.rule}
                  {f.preview && <code className="rounded-control bg-zinc-500/10 px-1 font-mono text-[11px] font-normal text-muted">{f.preview}</code>}
                </p>
                <p className="text-[13px] leading-snug text-zinc-600 dark:text-zinc-400">{f.message}</p>
              </div>
              <RefLink refTo={{ path: f.path, line: f.line ?? undefined }} keep={2} className="ml-auto" />
            </li>
          );
        })}
      </ul>
    </section>
  );
};
