#!/bin/sh
# Installs the newest reflektor release for a coding agent. macOS, Linux and Git Bash on Windows.
#
#   curl -fsSL https://reflektor.dev/install.sh | sh                          Claude Code
#   curl -fsSL https://reflektor.dev/install.sh | sh -s -- --target agents    Codex and other agents (~/.agents/skills)
#   curl -fsSL https://reflektor.dev/install.sh | sh -s -- --target claude --target agents
#
# It needs Node.js 18 or later, git, curl and tar. It downloads the release's manifest and checks its Ed25519
# signature against reflektor's release key, then downloads the package and checks its SHA-256, unpacks it into
# ~/.reflektor/versions/<version>/ and runs its install.mjs, which links or copies it into the agent's skills folder.
# Nothing is installed when a check fails. Running it again installs the newest release over the one there.
#
# REFLEKTOR_RELEASES_URL installs from somewhere else (scripts/release-stub.mts for a local test release). Only with
# REFLEKTOR_ALLOW_DEV_KEY=1 does it also accept the dev key such a test release is signed with.
set -eu

releases="${REFLEKTOR_RELEASES_URL:-https://github.com/bashovski/reflektor/releases/latest/download}"
releases="${releases%/}"
home="${REFLEKTOR_HOME:-$HOME/.reflektor}"

fail() {
  echo "error: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 18 or later is required: https://nodejs.org"
command -v git >/dev/null 2>&1 || fail "git is required: https://git-scm.com"
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail "Node.js 18 or later is required. This is $(node --version)."

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t reflektor)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Checking the newest reflektor release..."
curl -fsSL "$releases/manifest.json" -o "$tmp/manifest.json" || fail "Could not download $releases/manifest.json"
curl -fsSL "$releases/manifest.json.sig" -o "$tmp/manifest.json.sig" || fail "Could not download $releases/manifest.json.sig"

# Checks the signature with the release key (and the dev key only when asked), then prints "<version> <file>".
info="$(REFLEKTOR_ALLOW_DEV_KEY="${REFLEKTOR_ALLOW_DEV_KEY:-}" node -e '
const { createPublicKey, verify } = require("crypto");
const { readFileSync } = require("fs");
const dir = process.argv[1];
const keys = ["MCowBQYDK2VwAyEAmIPz+JhC77PTi74OQLD7TMZClvvE2w8BNBcIOCOstnA="];
if (process.env.REFLEKTOR_ALLOW_DEV_KEY === "1") keys.push("MCowBQYDK2VwAyEAvsRvnnXMy/JwuzdISDaHtfdwoyrffj/OyHmDHDcEYDQ=");
const bytes = readFileSync(dir + "/manifest.json");
const sig = Buffer.from(readFileSync(dir + "/manifest.json.sig", "utf8").trim(), "base64");
const ok = keys.some((k) => { try { return verify(null, bytes, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), sig); } catch { return false; } });
if (!ok) { console.error("The release signature does not match reflektor'"'"'s release key."); process.exit(1); }
const m = JSON.parse(bytes.toString("utf8"));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version) || !/^reflektor-[0-9A-Za-z.+-]+\.tar\.gz$/.test(m.file) || !/^[0-9a-f]{64}$/.test(m.sha256)) { console.error("The release manifest is not valid."); process.exit(1); }
console.log(m.version + " " + m.file);
' "$tmp")" || fail "The release did not check out, so nothing was installed."
version="${info%% *}"
file="${info#* }"

echo "Downloading reflektor $version..."
curl -fsSL "$releases/$file" -o "$tmp/$file" || fail "Could not download $releases/$file"
node -e '
const { createHash } = require("crypto");
const { readFileSync } = require("fs");
const m = JSON.parse(readFileSync(process.argv[1] + "/manifest.json", "utf8"));
const bytes = readFileSync(process.argv[1] + "/" + m.file);
if (bytes.length !== m.size || createHash("sha256").update(bytes).digest("hex") !== m.sha256) { console.error("The download does not match the release checksum."); process.exit(1); }
' "$tmp" || fail "The download did not check out, so nothing was installed."

mkdir -p "$home/versions"
partial="$home/versions/.$version.$$.partial"
rm -rf "$partial"
mkdir -p "$partial"
tar -xzf "$tmp/$file" -C "$partial" || { rm -rf "$partial"; fail "Could not unpack the release."; }
rm -rf "$home/versions/$version"
mv "$partial" "$home/versions/$version"

node "$home/versions/$version/scripts/install.mjs" activate "$@"
