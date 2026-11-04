import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const PLACEHOLDER = "__PR_REPORT_DATA__";

const sampleData = (): Plugin => ({
  name: "pr-report-sample-data",
  apply: "serve",
  transformIndexHtml(html) {
    const file = resolve(import.meta.dirname, "../samples/bundle.json");
    if (!existsSync(file)) return html;
    const json = readFileSync(file, "utf8").replace(/</g, "\\u003c");
    return html.replace(PLACEHOLDER, () => json);
  },
});

// Two builds:
//   app         dist/app: the page the review daemon serves at /app/. Normal files the browser caches,
//               with each language and theme in its own chunk, loaded only when a diff needs it.
//   standalone  dist/standalone/index.html: one self-contained file for exporting a report.
export default defineConfig(({ command, mode }) =>
  mode === "standalone"
    ? {
        plugins: [react(), tailwindcss(), viteSingleFile()],
        build: { outDir: "dist/standalone", assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000 },
      }
    : {
        base: command === "build" ? "/app/" : "/",
        plugins: [react(), tailwindcss(), sampleData()],
        build: { outDir: "dist/app", chunkSizeWarningLimit: 2_000 },
      },
);
