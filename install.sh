#!/usr/bin/env bash
# Builds the viewer and installs the pr-report skill for Claude Code.
#   ./install.sh          link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
#   ./install.sh --copy   copy skill/ instead; use this if a Claude Code update removed the link
# The work happens in scripts/install.mjs, which also runs on its own in PowerShell or cmd on Windows.
set -euo pipefail

command -v node >/dev/null || { echo "error: Node.js 18 or newer is required"; exit 1; }
exec node "$(dirname "$0")/scripts/install.mjs" "$@"
