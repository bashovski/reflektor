#!/usr/bin/env node
// Turns the atom-material-icons package (MIT, Elior Boukhobza "Mallowigi") into skill/assets/file-icons.json:
// the filename rules plus every icon SVG. build.mjs then embeds only the icons a report's files use.
//
// Usage: node scripts/build-icons.mjs   (needs `pnpm install` in viewer/ first)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "viewer/node_modules/atom-material-icons");
if (!existsSync(pkg)) throw new Error("atom-material-icons is missing. Run `pnpm install` in viewer/ first.");

const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const rules = JSON.parse(readFileSync(join(pkg, "public/icon_associations.json"), "utf8")).associations.associations.regex;
const iconFile = (icon) => join(pkg, "public", icon);

// Smaller SVGs: no comments, no XML prolog, no runs of whitespace.
const minify = (svg) =>
  svg
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

const icons = {};
const kept = [];
for (const rule of rules) {
  const file = iconFile(rule.icon);
  if (!existsSync(file)) continue;
  const name = rule.icon.replace("/icons/files/", "").replace(/\.svg$/, "");
  icons[name] ??= minify(readFileSync(file, "utf8"));
  // The rules come from the JetBrains plugin, where a pattern must match the whole file name.
  kept.push([`^(?:${rule.pattern})$`, name, rule.color]);
}
icons.default = minify(readFileSync(iconFile("/icons/files/default.svg"), "utf8"));

const out = join(root, "skill/assets/file-icons.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    source: `atom-material-icons ${version}, MIT License, Copyright (c) Elior Boukhobza "Mallowigi"`,
    // First matching rule wins: [regex tested on the file name, icon name, color for icons without their own fill]
    rules: kept,
    icons,
  }),
);
console.log(`Wrote ${out}: ${kept.length} rules, ${Object.keys(icons).length} icons`);
