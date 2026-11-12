// SKILL.md for an agent other than Claude Code. The file in skill/ is written for every agent, but two
// things in it only Claude Code understands: the `${CLAUDE_SKILL_DIR}` name it replaces with the skill's
// folder, and two front matter fields of its own (`allowed-tools`, with its permission rule syntax, and
// `argument-hint`). A copy for another agent gets the folder written out and those fields left out. What
// remains is the open Agent Skills format: `name`, `description` and the text.

const CLAUDE_ONLY = /^(allowed-tools|argument-hint):/;

export function portableSkillText(text: string, skillDir: string): string {
  // Forward slashes, also on Windows: the path goes into commands the agent runs in a POSIX shell.
  const dir = skillDir.replace(/\\/g, "/");
  const lines = text.split("\n");
  // The front matter sits between the first two "---" lines.
  const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1;
  const kept = lines.filter((line, i) => !(i > 0 && i < end && CLAUDE_ONLY.test(line)));
  return kept.join("\n").replaceAll("${CLAUDE_SKILL_DIR}", dir);
}
