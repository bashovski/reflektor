#!/usr/bin/env bash
# Builds the viewer and installs the pr-report skill for a coding agent.
#   ./install.sh                    Claude Code: link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
#   ./install.sh --copy             Claude Code: copy skill/ instead; use this if a Claude Code update removed the link
#   ./install.sh --target agents    other agents: a copy in ~/.agents/skills/pr-report, which Codex and others read
#   ./install.sh --target <folder>  a copy in any other skills folder
# The work happens in scripts/install.mts, which also runs on its own in PowerShell or cmd on Windows.
set -euo pipefail

# The scripts are TypeScript (.mts) that Node runs directly, which it does without a flag from 22.18.
[ "$(node -p 'Boolean(process.features.typescript)' 2>/dev/null)" = true ] || { echo "error: Node.js 22.18 or newer is required (found: $(node --version 2>/dev/null || echo none))"; exit 1; }
exec node "$(dirname "$0")/scripts/install.mts" "$@"
