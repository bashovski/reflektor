// Releases: where they are published, how one is checked, and how it is unpacked. Each release is three files next
// to each other: manifest.json, manifest.json.sig (an Ed25519 signature of the manifest's exact bytes) and the
// tarball the manifest names, whose SHA-256 the manifest holds. scripts/pack-release.mts makes them, the release
// workflow signs with the key in the repo's secrets, and install.sh, install.ps1 and the daemon check them here.
//
// Only a release build trusts nothing but the release key. A build from a checkout also trusts the dev key, so the
// check suite and local testing can install releases from scripts/release-stub.mts; PR_REPORT_ALLOW_DEV_KEY=1 does
// the same for a release build under test. A release signed with the dev key can never replace a real install.

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildInfo, isRelease, isVersion } from "./version.mjs";

// The manifest a release is described by.
export type Manifest = { version: string; sha256: string; size: number; file: string; publishedAt: string; notes: string[]; notesUrl: string | null };
// A release that could not be fetched or did not check out. `code` says which step: "network", "signature",
// "manifest", "checksum", "unpack".
export type ReleaseError = Error & { code: string };

export const DEFAULT_RELEASES_URL = "https://github.com/bashovski/pr-report/releases/latest/download";
// Where the releases are, without a trailing slash. PR_REPORT_RELEASES_URL points somewhere else: the local release
// server, or the platform if it serves releases one day.
export const releasesUrl = (env: NodeJS.ProcessEnv = process.env) => (env.PR_REPORT_RELEASES_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, "");

export const HOME = process.env.PR_REPORT_HOME ?? join(homedir(), ".pr-report");
export const VERSIONS_DIR = join(HOME, "versions");
const MAX_TARBALL = 100 * 1024 * 1024;
const CALL_MS = 15_000;
const DOWNLOAD_MS = 300_000;

// Public keys, as base64 DER (SPKI). The release key's private half lives only in the repo's Actions secrets.
export const RELEASE_KEY = "MCowBQYDK2VwAyEAmIPz+JhC77PTi74OQLD7TMZClvvE2w8BNBcIOCOstnA=";
// The dev key's private half is in scripts/release-stub.mts, on purpose: nothing but a dev build trusts it.
export const DEV_KEY = "MCowBQYDK2VwAyEAvsRvnnXMy/JwuzdISDaHtfdwoyrffj/OyHmDHDcEYDQ=";

export const trustedKeys = (env: NodeJS.ProcessEnv = process.env) => (isRelease() && env.PR_REPORT_ALLOW_DEV_KEY !== "1" ? [RELEASE_KEY] : [RELEASE_KEY, DEV_KEY]);

const failure = (code: string, message: string): ReleaseError => Object.assign(new Error(message), { code });

const signedBy = (bytes: Buffer, signature: Buffer, keys: string[]) =>
  keys.some((key) => {
    try {
      return verify(null, bytes, createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), signature);
    } catch {
      return false;
    }
  });

// The manifest, once its signature checks out and every field is what a release writes. Throws a ReleaseError.
export function verifyManifest(bytes: Buffer, signatureText: string, keys = trustedKeys()): Manifest {
  const signature = Buffer.from(signatureText.trim(), "base64");
  if (!signature.length || !signedBy(bytes, signature, keys)) throw failure("signature", "The release's signature does not match pr-report's release key, so nothing was installed.");
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(bytes.toString("utf8")) as Partial<Manifest>;
  } catch {
    throw failure("manifest", "The release's manifest is not valid JSON.");
  }
  const notes = Array.isArray(m.notes) ? m.notes.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter(Boolean).slice(0, 3) : [];
  if (
    !isVersion(m.version) ||
    typeof m.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.sha256) ||
    typeof m.size !== "number" ||
    m.size <= 0 ||
    m.size > MAX_TARBALL ||
    typeof m.file !== "string" ||
    !/^pr-report-[0-9A-Za-z.+-]+\.tar\.gz$/.test(m.file)
  )
    throw failure("manifest", "The release's manifest is missing a field or has one that is not valid.");
  return {
    version: m.version,
    sha256: m.sha256,
    size: m.size,
    file: m.file,
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : new Date(0).toISOString(),
    notes,
    notesUrl: typeof m.notesUrl === "string" && /^https:\/\//.test(m.notesUrl) ? m.notesUrl : null,
  };
}

async function fetchBytes(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": "pr-report" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = (e as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : ((e as { cause?: Error }).cause?.message ?? (e as Error).message);
    throw failure("network", `Could not download ${url}: ${reason}.`);
  }
  if (!res.ok) throw failure("network", `Could not download ${url}: HTTP ${res.status}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw failure("manifest", `${url} is larger than a release file can be.`);
  return bytes;
}

// The newest release's manifest, checked. Throws a ReleaseError.
export async function fetchManifest(base = releasesUrl()): Promise<Manifest> {
  const [bytes, signature] = await Promise.all([fetchBytes(`${base}/manifest.json`, CALL_MS, 64 * 1024), fetchBytes(`${base}/manifest.json.sig`, CALL_MS, 4 * 1024)]);
  return verifyManifest(bytes, signature.toString("utf8"));
}

export const versionDir = (version: string) => join(VERSIONS_DIR, version);

// Downloads the release a checked manifest names, checks its size and SHA-256, and unpacks it into
// ~/.pr-report/versions/<version>/. A version already there and complete is used as it is. Answers the folder.
// Nothing is left behind when a step fails. Throws a ReleaseError.
export async function downloadRelease(manifest: Manifest, base = releasesUrl()): Promise<string> {
  const dir = versionDir(manifest.version);
  const there = buildInfo(dir);
  if (there.version === manifest.version && there.channel === "release") return dir;

  const tarball = await fetchBytes(`${base}/${manifest.file}`, DOWNLOAD_MS, MAX_TARBALL);
  if (tarball.length !== manifest.size || createHash("sha256").update(tarball).digest("hex") !== manifest.sha256)
    throw failure("checksum", "The downloaded release does not match its manifest's checksum, so nothing was installed.");

  mkdirSync(VERSIONS_DIR, { recursive: true });
  const partial = join(VERSIONS_DIR, `.${manifest.version}.${process.pid}.partial`);
  const file = `${partial}.tar.gz`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    writeFileSync(file, tarball);
    unpack(file, partial);
    const unpacked = buildInfo(partial);
    if (unpacked.version !== manifest.version || unpacked.channel !== "release" || !existsSync(join(partial, "scripts", "daemon.mjs")))
      throw failure("unpack", "The downloaded release is not the version its manifest names.");
    rmSync(dir, { recursive: true, force: true });
    renameSync(partial, dir);
    return dir;
  } finally {
    rmSync(file, { force: true });
    rmSync(partial, { recursive: true, force: true });
  }
}

// tar ships with macOS, Linux and Windows 10 and later (bsdtar, as tar.exe).
export function unpack(file: string, into: string) {
  const r = spawnSync("tar", ["-xzf", file, "-C", into], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw failure("unpack", `Could not unpack the release: ${(r.stderr || r.error?.message || "tar failed").trim()}`);
}
