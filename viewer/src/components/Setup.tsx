import { useCallback, useEffect, useState } from "react";
import { CodeThemeStep, finishSetup, IntroStep, type SetupStep, SetupFrame, SpeedStep, ThemeStep, useCodeThemeKeys, useThemeKeys } from "./SetupSteps";
import { ScreenshotsStep } from "./SetupSteps";
import { ToolsStep } from "./ToolsStep";

// First-run setup: what pr-report is, the tools it can use, how reports get written, then how the page should look. The last
// step hands over to the inbox, which greets a first-timer and says how to start a report.
const STEPS: SetupStep[] = [
  { id: "intro", title: "Welcome to Reflektor", next: "Get started" },
  { id: "tools", title: "Your tools", next: "Continue" },
  { id: "speed", title: "Faster reports?", next: "Continue" },
  { id: "screenshots", title: "Screenshots of UI changes?", next: "Continue" },
  { id: "theme", title: "Light or dark?", next: "Continue" },
  { id: "code", title: "Pick a code theme", next: "Finish" },
];

export const Setup = () => {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const next = useCallback(() => (index < STEPS.length - 1 ? setIndex(index + 1) : finishSetup()), [index]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const themeKeys = useThemeKeys(step.id === "theme");
  const codeKeys = useCodeThemeKeys(step.id === "code");

  useEffect(() => {
    document.title = "Setup · Reflektor";
  }, []);

  // Enter moves on, even from a focused option button, so it never re-picks what is already picked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Enter") next();
      else if (e.key === "Escape") finishSetup();
      else if (!themeKeys(e) && !codeKeys(e)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, themeKeys, codeKeys]);

  return (
    <SetupFrame steps={STEPS} index={index} onBack={back} onNext={next} onSkip={finishSetup}>
      {step.id === "intro" && <IntroStep />}
      {step.id === "tools" && <ToolsStep />}
      {step.id === "speed" && <SpeedStep />}
      {step.id === "screenshots" && <ScreenshotsStep />}
      {step.id === "theme" && <ThemeStep />}
      {step.id === "code" && <CodeThemeStep />}
    </SetupFrame>
  );
};
