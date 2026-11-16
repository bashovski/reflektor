import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, transformWithOxc } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const PLACEHOLDER = "__REFLEKTOR_DATA__";

const sampleData = (): Plugin => ({
  name: "reflektor-sample-data",
  apply: "serve",
  transformIndexHtml(html) {
    const file = resolve(import.meta.dirname, "../samples/bundle.json");
    if (!existsSync(file)) return html;
    const json = readFileSync(file, "utf8").replace(/</g, "\\u003c");
    return html.replace(PLACEHOLDER, () => json);
  },
});

// The scripts that run outside the app, as plain scripts written into a page: the theme applied before the first
// paint (src/boot/theme.ts, put into index.html here) and the inbox's two (src/inbox/, which the daemon puts into the
// inbox page). They are TypeScript like the rest, compiled here one file at a time. Their only imports are types, which
// leave nothing behind but an `export {}` that a plain script cannot have.
async function plainScript(file: string) {
  const path = resolve(import.meta.dirname, file);
  const { code } = await transformWithOxc(readFileSync(path, "utf8"), path, { lang: "ts" });
  const script = code.replace(/\nexport \{\};\s*$/, "\n");
  if (/^\s*(import|export)\s/m.test(script)) throw new Error(`${file} must stay a plain script: type imports only, no exports`);
  // Written inside HTML, where either of these ends the script or starts a comment.
  if (/<\/script|<!--/i.test(script)) throw new Error(`${file} must not contain "</script" or "<!--"`);
  return script;
}

const bootTheme = (): Plugin => ({
  name: "reflektor-boot-theme",
  async transformIndexHtml(html) {
    return html.replace("<!-- src/boot/theme.ts -->", `<script>\n${await plainScript("src/boot/theme.ts")}</script>`);
  },
});

// dist/app/inbox.js and inbox-theme.js, which install.mts copies with the app and the daemon reads.
const inboxScripts = (): Plugin => ({
  name: "reflektor-inbox-scripts",
  apply: "build",
  async generateBundle() {
    for (const [fileName, file] of [
      ["inbox.js", "src/inbox/inbox.ts"],
      ["inbox-theme.js", "src/inbox/theme.ts"],
    ])
      this.emitFile({ type: "asset", fileName, source: await plainScript(file) });
  },
});

// Two builds:
//   app         dist/app: the page the review daemon serves at /app/. Normal files the browser caches,
//               with each language and theme in its own chunk, loaded only when a diff needs it.
//   standalone  dist/standalone/index.html: one self-contained file for exporting a report.
export default defineConfig(({ command, mode }) =>
  mode === "standalone"
    ? {
        plugins: [react(), tailwindcss(), bootTheme(), viteSingleFile()],
        build: { outDir: "dist/standalone", assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000 },
      }
    : {
        base: command === "build" ? "/app/" : "/",
        plugins: [react(), tailwindcss(), sampleData(), bootTheme(), inboxScripts()],
        build: { outDir: "dist/app", chunkSizeWarningLimit: 2_000 },
      },
);
