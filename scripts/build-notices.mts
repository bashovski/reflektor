#!/usr/bin/env node
// Writes skill/THIRD-PARTY-NOTICES.md: the license of every package that ships inside pr-report, with its
// text. The viewer bundles its runtime dependencies into assets/, the file icons come from
// atom-material-icons, and Tailwind generates the stylesheet, so all of those are covered. Apache-2.0,
// MIT, ISC and OFL all ask for their license text to travel with the code.
//
// Source that was copied into viewer/src/vendor instead of installed is covered too, from the license file kept
// next to it.
//
// Run it after changing viewer/package.json or viewer/src/vendor; scripts/check.mts fails when a runtime dependency
// or a vendor folder is missing here.
// Usage: pnpm run notices

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./paths.mjs";

const modules = join(root, "viewer", "node_modules");
// The fields of a package.json read here.
type PackageJson = {
  version: string;
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies: Record<string, string>;
};

const viewer = JSON.parse(readFileSync(join(root, "viewer", "package.json"), "utf8")) as PackageJson;

// Why each one ships, for the reader of the notices file.
const WHY: Record<string, string> = {
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
  "atom-material-icons": "the file type icons in assets/file-icons.json",
};

const packages = [...Object.keys(viewer.dependencies), "tailwindcss", "atom-material-icons"];

// Source copied into the viewer by hand. Each is a folder in viewer/src/vendor that holds the code and its license
// file, and it gets a section like a package does.
const COPIED = [
  {
    folder: "react-bits",
    what: "the Dither component",
    license: "MIT with a Commons Clause",
    why: "the background of the setup wizard",
    link: "https://reactbits.dev/backgrounds/dither",
  },
];

const licenseText = (dir: string) => {
  const file = readdirSync(dir).find((name) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(name));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
};
const repositoryUrl = (pkg: PackageJson) => {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return pkg.homepage ?? (repo ? repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://") : null);
};

const sections: string[] = [];
const missing: string[] = [];
for (const name of packages) {
  const dir = join(modules, name);
  if (!existsSync(join(dir, "package.json"))) {
    missing.push(name);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
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
for (const { folder, what, license, why, link } of COPIED) {
  const dir = join(root, "viewer", "src", "vendor", folder);
  const text = existsSync(dir) ? licenseText(dir) : null;
  if (!text) {
    missing.push(`viewer/src/vendor/${folder} (no license file)`);
    continue;
  }
  sections.push(`## ${folder} (${what}, copied into viewer/src/vendor/${folder})\n\nLicense: ${license}. Used for ${why}. ${link}\n\n` + "```\n" + `${text}\n` + "```\n");
}
if (missing.length) {
  console.error(`Cannot write the notices, these packages are missing or have no license file: ${missing.join(", ")}. Run pnpm install in viewer/ first.`);
  process.exit(1);
}

const header =
  `# Third-party notices\n\n` +
  `pr-report ships the open source packages below inside the skill: the viewer bundles its dependencies into \`assets/\`, ` +
  `the inbox serves Fuse.js, the file type icons come from atom-material-icons, Tailwind CSS generated the stylesheet, ` +
  `and the setup wizard's background is source copied from React Bits. ` +
  `Each one's license follows. This file is written by \`scripts/build-notices.mts\` from the installed packages and from \`viewer/src/vendor\`.\n\n`;
const out = join(root, "skill", "THIRD-PARTY-NOTICES.md");
writeFileSync(out, header + sections.join("\n"));
console.log(`Wrote ${out}: ${sections.length} sections.`);
