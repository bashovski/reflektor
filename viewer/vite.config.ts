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

export default defineConfig({
  plugins: [react(), tailwindcss(), sampleData(), viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000 },
});
