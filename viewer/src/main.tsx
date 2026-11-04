import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Bundle } from "../../skill/schema/types";
import { App } from "./components/App";
import "./index.css";

const readBundle = (): Bundle | null => {
  const text = document.getElementById("pr-report-data")?.textContent?.trim() ?? "";
  return text.startsWith("{") ? (JSON.parse(text) as Bundle) : null;
};

const bundle = readBundle();
const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    {bundle ? (
      <App bundle={bundle} />
    ) : (
      <p className="p-10 text-sm text-zinc-500">No report data found in this file.</p>
    )}
  </StrictMode>,
);
