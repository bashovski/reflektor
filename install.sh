#!/usr/bin/env bash
# Builds the pr-report skill and installs it for a coding agent: pnpm build, then pnpm run deploy.
#   ./install.sh                    Claude Code: link ~/.claude/skills/pr-report to the built package, dist/skill/
#   ./install.sh --copy             Claude Code: copy dist/skill/ instead; use this if a Claude Code update removed the link
#   ./install.sh --target agents    other agents: a copy in ~/.agents/skills/pr-report, which Codex and others read
#   ./install.sh --target <folder>  a copy in any other skills folder
# The tools are TypeScript in scripts/, compiled into dist/tools/ first and run from there. On Windows without bash,
# run pnpm build and pnpm run deploy instead.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "error: Node.js is required"; exit 1; }
if command -v pnpm >/dev/null; then (cd "$here/viewer" && pnpm install --frozen-lockfile); else (cd "$here/viewer" && npm install); fi
node "$here/viewer/node_modules/typescript/bin/tsc" -p "$here/tsconfig.tools.json"
node "$here/dist/tools/scripts/build-skill.mjs"
exec node "$here/dist/tools/scripts/deploy.mjs" "$@"
