#!/usr/bin/env bash
# Builds the pr-report skill from this checkout and installs it for a coding agent: pnpm build, then pnpm run deploy.
# For contributors. Everyone else installs a release with install.sh.
#   ./install-from-source.sh                    Claude Code: link ~/.claude/skills/pr-report to the built package, dist/skill/
#   ./install-from-source.sh --copy             Claude Code: copy dist/skill/ instead; use this if a Claude Code update removed the link
#   ./install-from-source.sh --target agents    other agents: a copy in ~/.agents/skills/pr-report, which Codex and others read
#   ./install-from-source.sh --target <folder>  a copy in any other skills folder
# The tools are TypeScript in scripts/, compiled into dist/tools/ first and run from there. On Windows without bash,
# run pnpm build and pnpm run deploy instead.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "error: Node.js is required"; exit 1; }
if command -v pnpm >/dev/null; then (cd "$here/viewer" && pnpm install --frozen-lockfile); else (cd "$here/viewer" && npm install); fi
node "$here/viewer/node_modules/typescript/bin/tsc" -p "$here/tsconfig.tools.json"
node "$here/dist/tools/scripts/build-skill.mjs"
exec node "$here/dist/tools/scripts/deploy.mjs" "$@"
