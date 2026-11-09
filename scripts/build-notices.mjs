#!/usr/bin/env node
// Writes skill/THIRD-PARTY-NOTICES.md: the license of every package that ships inside pr-report, with its
// text. The viewer bundles its runtime dependencies into skill/assets, the file icons come from
// atom-material-icons, and Tailwind generates the stylesheet, so all of those are covered. Apache-2.0,
// MIT, ISC and OFL all ask for their license text to travel with the code.
//
// Run it after changing viewer/package.json; scripts/check.mjs fails when a runtime dependency is missing here.
// Usage: node scripts/build-notices.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "viewer", "node_modules");
const viewer = JSON.parse(readFileSync(join(root, "viewer", "package.json"), "utf8"));

// Why each one ships, for the reader of the notices file.
const WHY = {
  "@fontsource-variable/geist": "the page's text font",
  "@fontsource-variable/geist-mono": "the page's code font",
  "@headlessui/react": "the menus and dialogs",
  "@pierre/diffs": "renders the diffs and highlights code",
  "fuse.js": "search in the inbox",
  "lucide-react": "the icons",
  react: "the page",
  "react-dom": "the page",
  shiki: "the code highlighting themes",
  tailwindcss: "generated the page's stylesheet at build time",
  "atom-material-icons": "the file type icons in skill/assets/file-icons.json",
};

const packages = [...Object.keys(viewer.dependencies), "tailwindcss", "atom-material-icons"];

const licenseText = (dir) => {
  const file = readdirSync(dir).find((name) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(name));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
};
const repositoryUrl = (pkg) => {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return pkg.homepage ?? (repo ? repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://") : null);
};

const sections = [];
const missing = [];
for (const name of packages) {
  const dir = join(modules, name);
  if (!existsSync(join(dir, "package.json"))) {
    missing.push(name);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const text = licenseText(dir);
  if (!text) missing.push(`${name} (no license file)`);
  const link = repositoryUrl(pkg);
  sections.push(
    `## ${name} ${pkg.version}\n\n` +
      `License: ${pkg.license ?? "see below"}. Used for ${WHY[name] ?? "the page"}.${link ? ` ${link}` : ""}\n\n` +
      "```\n" +
      `${text ?? "License text not found in the package."}\n` +
      "```\n",
  );
}
if (missing.length) {
  console.error(`Cannot write the notices, these packages are missing or have no license file: ${missing.join(", ")}. Run pnpm install in viewer/ first.`);
  process.exit(1);
}

const header =
  `# Third-party notices\n\n` +
  `pr-report ships the open source packages below inside the skill: the viewer bundles its dependencies into \`skill/assets\`, ` +
  `the inbox serves Fuse.js, the file type icons come from atom-material-icons, and Tailwind CSS generated the stylesheet. ` +
  `Each package's license follows. This file is written by \`scripts/build-notices.mjs\` from the installed packages.\n\n`;
const out = join(root, "skill", "THIRD-PARTY-NOTICES.md");
writeFileSync(out, header + sections.join("\n"));
console.log(`Wrote ${out}: ${sections.length} packages.`);
