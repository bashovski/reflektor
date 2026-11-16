#!/usr/bin/env node
// Packs dist/skill/ as a release: the files a GitHub Release carries and install.sh, install.ps1 and the daemon read
// (skill/scripts/release.mts).
//
//   dist/release/reflektor-<version>.tar.gz   the package, with build.json marked as a release
//   dist/release/manifest.json                version, SHA-256, size, file, publishedAt, notes, notesUrl
//   dist/release/manifest.json.sig            Ed25519 signature of manifest.json's exact bytes, base64
//   dist/release/install.sh, install.ps1      the installers, so the release page links them too
//
// Usage: pnpm release:pack, which builds first. Then:
//   node dist/tools/scripts/pack-release.mjs [--dev] [--version <v>] [--notes-file <file>] [--notes-url <url>] [--out <dir>]
//
// The release workflow signs with REFLEKTOR_RELEASE_KEY (the private key, PEM or base64 DER), from the repo's secrets.
// --dev signs with the dev key instead, for scripts/release-stub.mts: only builds from a checkout trust that key.
// --version packs the same build as another version, which the check suite uses to make an "update".
// The notes are the first three "- " lines under "## Notes" in the notes file (the release's text).

import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "./paths.mjs";
import { DEV_PRIVATE_KEY } from "./release-stub.mjs";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const pkg = join(root, "dist", "skill");
if (!existsSync(join(pkg, "build.json"))) fail("dist/skill/ is not built yet. Run pnpm build first.");
const built = JSON.parse(readFileSync(join(pkg, "build.json"), "utf8")) as { version: string; commit?: string | null };
const version = arg("version") ?? built.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`${version} is not a version.`);

const keyText = args.includes("--dev") ? DEV_PRIVATE_KEY : process.env.REFLEKTOR_RELEASE_KEY;
if (!keyText) fail("Set REFLEKTOR_RELEASE_KEY to the release key, or pass --dev for a local release.");
const key = keyText!.includes("BEGIN") ? createPrivateKey(keyText!) : createPrivateKey({ key: Buffer.from(keyText!.trim(), "base64"), format: "der", type: "pkcs8" });

const notesFile = arg("notes-file");
const notes = notesFile
  ? (readFileSync(notesFile, "utf8").split(/^## Notes\s*$/m)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .slice(0, 3)
  : [];

const out = resolve(arg("out") ?? join(root, "dist", "release"));
const stage = join(root, "dist", ".release-stage");
rmSync(stage, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(pkg, stage, { recursive: true });
writeFileSync(join(stage, "build.json"), `${JSON.stringify({ ...built, version, channel: "release" }, null, 2)}\n`);

const file = `reflektor-${version}.tar.gz`;
const tarball = join(out, file);
// --no-xattrs keeps macOS's extended attributes out, so Linux tar does not warn about them on unpacking.
const mac = process.platform === "darwin";
const tar = spawnSync("tar", [...(mac ? ["--no-xattrs", "--no-mac-metadata"] : []), "-czf", tarball, "-C", stage, "."], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
if (tar.status !== 0) fail(`tar failed: ${tar.stderr}`);
rmSync(stage, { recursive: true, force: true });

const bytes = readFileSync(tarball);
const manifest = {
  version,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  file,
  publishedAt: new Date().toISOString(),
  notes,
  notesUrl: arg("notes-url"),
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, "manifest.json"), manifestBytes);
writeFileSync(join(out, "manifest.json.sig"), `${sign(null, manifestBytes, key).toString("base64")}\n`);
for (const installer of ["install.sh", "install.ps1"]) cpSync(join(root, installer), join(out, installer));

console.log(`Packed reflektor ${version} into ${out}${args.includes("--dev") ? " (signed with the dev key)" : ""}`);
