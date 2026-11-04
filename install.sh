#!/usr/bin/env bash
# Builds the viewer and installs the pr-report skill for Claude Code.
#   ./install.sh          link ~/.claude/skills/pr-report to this repo's skill/ folder (edits apply right away)
#   ./install.sh --copy   copy skill/ instead; use this if a Claude Code update removed the link
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
TARGET="$SKILLS_DIR/pr-report"
MODE="link"
[ "${1:-}" = "--copy" ] && MODE="copy"

command -v node >/dev/null || { echo "error: Node.js 18 or newer is required"; exit 1; }

echo "Building the viewer..."
cd "$ROOT/viewer"
if command -v pnpm >/dev/null; then
  pnpm install --frozen-lockfile --silent
  pnpm build >/dev/null
else
  npm install --silent
  npm run build --silent >/dev/null
fi
mkdir -p "$ROOT/skill/assets"
cp "$ROOT/viewer/dist/index.html" "$ROOT/skill/assets/viewer.html"

mkdir -p "$SKILLS_DIR"
if [ -L "$TARGET" ]; then
  rm "$TARGET"
elif [ -d "$TARGET" ]; then
  if ! grep -q '^name: pr-report$' "$TARGET/SKILL.md" 2>/dev/null; then
    echo "error: $TARGET exists and is not this skill. Move it away first."
    exit 1
  fi
  rm -rf "$TARGET"
fi

if [ "$MODE" = "link" ]; then
  ln -s "$ROOT/skill" "$TARGET"
else
  cp -R "$ROOT/skill" "$TARGET"
fi

echo "Installed pr-report ($MODE): $TARGET"
echo "Try it in any repo: /pr-report"
