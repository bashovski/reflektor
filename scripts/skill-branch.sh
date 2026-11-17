#!/usr/bin/env bash
# Puts a built reflektor package on a branch of its own, for `npx skills add bashovski/reflektor#skill`. The release
# workflow runs it with the release's tarball after publishing; run it by hand with another branch name to try it.
#
#   scripts/skill-branch.sh <reflektor-x.y.z.tar.gz | package folder> [branch]    branch defaults to skill
#
# The branch holds only the package: each run replaces its files and adds one commit, so `npx skills update` sees
# the change. build.json gets `"distribution": "skills"`, which tells the skill that npx skills, not reflektor
# itself, updates it. The branch is never merged anywhere; the source stays on main.
set -euo pipefail

src="${1:?usage: scripts/skill-branch.sh <tarball or package folder> [branch]}"
branch="${2:-skill}"
root="$(git rev-parse --show-toplevel)"
dir="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"' EXIT

if git -C "$root" fetch -q origin "$branch" 2>/dev/null; then
  git -C "$root" worktree add -q --detach "$dir" FETCH_HEAD
  git -C "$dir" checkout -q -B "$branch"
else
  git -C "$root" worktree add -q --detach "$dir"
  git -C "$dir" checkout -q --orphan "$branch"
fi

find "$dir" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
if [ -d "$src" ]; then cp -R "$src/." "$dir/"; else tar -xzf "$src" -C "$dir"; fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const info = JSON.parse(fs.readFileSync(file, "utf8"));
if (info.channel !== "release") { console.error(`error: ${file} is not a release build (channel ${info.channel})`); process.exit(1); }
fs.writeFileSync(file, `${JSON.stringify({ ...info, distribution: "skills" }, null, 2)}\n`);
' "$dir/build.json"
version="$(node -p 'require(process.argv[1]).version' "$dir/build.json")"

cat > "$dir/README.md" <<EOF
# reflektor ${version}

This branch holds the built reflektor skill. Each release replaces it. Install it with:

\`\`\`bash
npx skills add bashovski/reflektor#skill
\`\`\`

Do not edit it here: the source is on the main branch of https://github.com/bashovski/reflektor.
EOF

git -C "$dir" add -A
git -C "$dir" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "reflektor ${version}"
git -C "$dir" push -q origin "HEAD:refs/heads/${branch}"
echo "Pushed reflektor ${version} to ${branch} ($(git -C "$dir" rev-parse --short HEAD))"
