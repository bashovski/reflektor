#!/usr/bin/env bash
# Builds the pr-report skill and installs it for a coding agent: pnpm build, then pnpm run deploy.
#   ./install.sh                    Claude Code: link ~/.claude/skills/pr-report to the built package, dist/skill/
#   ./install.sh --copy             Claude Code: copy dist/skill/ instead; use this if a Claude Code update removed the link
#   ./install.sh --target agents    other agents: a copy in ~/.agents/skills/pr-report, which Codex and others read
#   ./install.sh --target <folder>  a copy in any other skills folder
# The work happens in scripts/build-skill.mts and scripts/deploy.mts, which also run on their own in PowerShell or cmd
# on Windows.
set -euo pipefail

# The build runs TypeScript, which Node does without a flag from 22.18. The skill it builds runs on Node 18.
[ "$(node -p 'Boolean(process.features.typescript)' 2>/dev/null)" = true ] || { echo "error: building pr-report needs Node.js 22.18 or newer (found: $(node --version 2>/dev/null || echo none)). The skill it builds runs on Node 18."; exit 1; }
node "$(dirname "$0")/scripts/build-skill.mts"
exec node "$(dirname "$0")/scripts/deploy.mts" "$@"
