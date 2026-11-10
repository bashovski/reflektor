#!/usr/bin/env bash
# Builds the viewer and installs the pr-report skill for a coding agent.
#   ./install.sh                    Claude Code: link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
#   ./install.sh --copy             Claude Code: copy skill/ instead; use this if a Claude Code update removed the link
#   ./install.sh --target agents    other agents: a copy in ~/.agents/skills/pr-report, which Codex and others read
#   ./install.sh --target <folder>  a copy in any other skills folder
# The work happens in scripts/install.mjs, which also runs on its own in PowerShell or cmd on Windows.
set -euo pipefail

command -v node >/dev/null || { echo "error: Node.js 18 or newer is required"; exit 1; }
exec node "$(dirname "$0")/scripts/install.mjs" "$@"
