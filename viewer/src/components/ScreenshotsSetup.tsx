import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { pageToken } from "../lib/panel";
import { useAgentSettings } from "../lib/settings";
import { SettingSwitch } from "./Settings";
import { Command } from "./ToolsStep";
import { cx } from "./ui";

// Screenshots of the changed UI: whether Playwright and its Chromium are on this machine, and the switch. The daemon
// checks both (GET /api/setup/playwright) and this asks it every few seconds while it is on screen, so the ticks
// appear as soon as an install in a terminal finishes. Shown as a step of the setup wizard and as a section of Settings.

type Report = {
  playwright: { found: boolean; version: string | null; from: "repo" | "global" | "env" | null };
  chromium: { found: boolean };
  chrome?: { found: boolean };
  install: { playwright: string; chromium: string } | null;
};

const INSTALL = { playwright: "npm install -g playwright", chromium: "npx playwright install chromium" };

const usePlaywright = () => {
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    const token = pageToken();
    if (!token) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/setup/playwright", { headers: { "x-review-token": token } });
        if (res.ok && !stopped) setReport((await res.json()) as Report);
      } catch {
        // The daemon is away for a moment; the next poll tries again.
      }
    };
    void poll();
    const id = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);
  return report;
};

const Row = ({ label, found, detail, command }: { label: string; found: boolean | null; detail: string; command: string }) => (
  <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
    <span
      className={cx("grid size-5 shrink-0 place-items-center rounded-full", found ? "bg-ok-500 text-white" : "border border-[var(--border)] text-faint")}
      title={found ? "Installed" : "Not installed"}
    >
      {found === null ? <Loader2 className="size-3 animate-spin" /> : found ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-xs text-muted">{detail}</span>
    </span>
    {found === false && <Command text={command} />}
  </li>
);

export const ScreenshotsSetup = () => {
  const { settings, change } = useAgentSettings();
  const report = usePlaywright();
  const install = report?.install ?? INSTALL;
  const browser = Boolean(report?.chromium.found || report?.chrome?.found);
  const ready = Boolean(report?.playwright.found && browser);
  const playwrightDetail = !report
    ? "Checking…"
    : report.playwright.found
      ? `Installed${report.playwright.version ? ` (${report.playwright.version})` : ""}`
      : "Not installed globally. A project's own Playwright works too.";

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-[var(--border)] rounded-control border border-[var(--border)]">
        <Row label="Playwright" found={report ? report.playwright.found : null} detail={playwrightDetail} command={install.playwright} />
        <Row
          label="A browser"
          found={report ? browser : null}
          detail={
            !report ? "Checking…" : report.chromium.found ? "Playwright's Chromium" : report.chrome?.found ? "Your Google Chrome" : "Playwright's Chromium, or Google Chrome, is not installed"
          }
          command={install.chromium}
        />
      </ul>
      {settings && (
        <SettingSwitch
          on={settings.screenshots}
          onChange={(next) => change({ screenshots: next })}
          title="Take screenshots"
          hint={
            ready || !report
              ? "Uses more tokens. Only runs for changes to UI files."
              : `${report.playwright.found ? "Install a browser above first." : browser ? "Install Playwright above first, or add it to the project." : "Install the two above first."} Uses more tokens.`
          }
        />
      )}
    </div>
  );
};
