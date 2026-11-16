# Installs the newest pr-report release for a coding agent, on Windows (PowerShell 5.1 or later).
#
#   irm https://reflektor.dev/install.ps1 | iex                                    Claude Code
#   & ([scriptblock]::Create((irm https://reflektor.dev/install.ps1))) -Target agents   Codex and other agents
#
# The same steps as install.sh: check the manifest's Ed25519 signature with Node.js, download the package and check
# its SHA-256, unpack it into ~\.pr-report\versions\<version>\ with tar.exe (Windows 10 and later), then run its
# install.mjs. Nothing is installed when a check fails.
param([string[]]$Target = @(), [switch]$NoOpen)
$ErrorActionPreference = "Stop"

$releases = if ($env:PR_REPORT_RELEASES_URL) { $env:PR_REPORT_RELEASES_URL.TrimEnd("/") } else { "https://github.com/bashovski/pr-report/releases/latest/download" }
$home_ = if ($env:PR_REPORT_HOME) { $env:PR_REPORT_HOME } else { Join-Path $HOME ".pr-report" }

function Fail($message) { Write-Error "error: $message"; exit 1 }

foreach ($tool in "node", "git", "tar") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool is required." }
}
& node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { Fail "Node.js 18 or later is required." }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pr-report-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Checking the newest pr-report release..."
  Invoke-WebRequest -UseBasicParsing "$releases/manifest.json" -OutFile (Join-Path $tmp "manifest.json")
  Invoke-WebRequest -UseBasicParsing "$releases/manifest.json.sig" -OutFile (Join-Path $tmp "manifest.json.sig")

  $verify = @'
const { createHash, createPublicKey, verify } = require("crypto");
const { readFileSync, existsSync } = require("fs");
const dir = process.argv[1];
const keys = ["MCowBQYDK2VwAyEAmIPz+JhC77PTi74OQLD7TMZClvvE2w8BNBcIOCOstnA="];
if (process.env.PR_REPORT_ALLOW_DEV_KEY === "1") keys.push("MCowBQYDK2VwAyEAvsRvnnXMy/JwuzdISDaHtfdwoyrffj/OyHmDHDcEYDQ=");
const bytes = readFileSync(dir + "/manifest.json");
const sig = Buffer.from(readFileSync(dir + "/manifest.json.sig", "utf8").trim(), "base64");
const ok = keys.some((k) => { try { return verify(null, bytes, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), sig); } catch { return false; } });
if (!ok) { console.error("The release signature does not match the release key."); process.exit(1); }
const m = JSON.parse(bytes.toString("utf8"));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version) || !/^pr-report-[0-9A-Za-z.+-]+\.tar\.gz$/.test(m.file) || !/^[0-9a-f]{64}$/.test(m.sha256)) { console.error("The release manifest is not valid."); process.exit(1); }
const tarball = dir + "/" + m.file;
if (existsSync(tarball)) {
  const t = readFileSync(tarball);
  if (t.length !== m.size || createHash("sha256").update(t).digest("hex") !== m.sha256) { console.error("The download does not match the release checksum."); process.exit(1); }
}
console.log(m.version + " " + m.file);
'@
  $script = Join-Path $tmp "verify.js"
  Set-Content -Path $script -Value $verify -Encoding UTF8

  $info = & node $script $tmp
  if ($LASTEXITCODE -ne 0) { Fail "The release did not check out, so nothing was installed." }
  $version, $file = "$info".Split(" ", 2)

  Write-Host "Downloading pr-report $version..."
  Invoke-WebRequest -UseBasicParsing "$releases/$file" -OutFile (Join-Path $tmp $file)
  & node $script $tmp | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "The download did not check out, so nothing was installed." }

  $versions = Join-Path $home_ "versions"
  New-Item -ItemType Directory -Force -Path $versions | Out-Null
  $partial = Join-Path $versions (".$version.$PID.partial")
  if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
  New-Item -ItemType Directory -Path $partial | Out-Null
  & tar -xzf (Join-Path $tmp $file) -C $partial
  if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $partial; Fail "Could not unpack the release." }
  $dest = Join-Path $versions $version
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $partial $dest

  $installArgs = @("activate")
  foreach ($t in $Target) { $installArgs += @("--target", $t) }
  if ($NoOpen) { $installArgs += "--no-open" }
  & node (Join-Path $dest "scripts\install.mjs") @installArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
