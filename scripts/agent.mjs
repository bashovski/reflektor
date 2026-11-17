// Which coding agent is running reflektor, so the page can say "Send to Codex" and not name one agent
// for everybody. review.mjs and build.mjs are started from the agent's own shell, so they can tell from
// what that shell carries. The daemon never detects: it outlives the session that started it and serves
// every agent on the machine, so each call tells it who is calling.
//
// The first source that answers wins:
//   1. --agent <id>, or REFLEKTOR_AGENT: said outright, for wrappers and tests.
//   2. AI_AGENT, a name several agents set, such as "claude-code_2-1-321_agent".
//   3. A marker only one agent sets (the "env" list in agents.json).
//   4. The skills folder the script was started from (the "paths" list). Node keeps the path as typed in
//      process.argv[1], also when the folder is a link.
//   5. --agent-name "<product>", or REFLEKTOR_AGENT_NAME: the agent's own answer, asked for by SKILL.md
//      only when the sources above found nothing.
//
// ../agents.json turns an id into the words the page shows: `name` for the assistant ("Send to Claude")
// and `product` for the program the user types into ("In Claude Code, run ..."), with `resume` being what
// they type there to pick a review up. An entry without `env` and `paths` is reached through 1, 2 and 5
// only: a marker goes in once it is checked against the real tool, since a wrong one would name the wrong
// agent. An agent with no entry still gets a tidy name made from its id.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const TABLE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agents.json"), "utf8"));
const MAX = 40;
// Names end up in the page and in a request header: one line, no control characters, not long.
const clean = (value) => typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX)
    : "";
// "Claude Code", "claude_code" and "claude-code" are the same thing to look up.
const key = (text) => clean(text).toLowerCase().replace(/[\s_]+/g, "-");
function lookup(text) {
    const wanted = key(text);
    if (!wanted)
        return null;
    for (const [id, entry] of Object.entries(TABLE)) {
        if ([id, entry.name, entry.product, ...(entry.aliases ?? [])].some((known) => key(known) === wanted))
            return id;
    }
    // "codex-cli" is still Codex. The longest id wins, so "gemini-cli" is not taken for a shorter one.
    return (Object.keys(TABLE)
        .filter((id) => wanted.startsWith(`${id}-`))
        .sort((a, b) => b.length - a.length)[0] ?? null);
}
// "some-agent" -> "Some Agent", for an agent the table does not know.
const tidy = (id) => clean(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
function describe(id, source, version = null) {
    const known = lookup(id);
    if (known) {
        const entry = TABLE[known];
        return { id: known, name: entry.name, product: entry.product, resume: entry.resume ?? null, version, source };
    }
    const name = tidy(id);
    return name ? { id: key(id), name, product: name, resume: null, version, source } : null;
}
// "claude-code_2-1-321_agent" -> ["claude-code", "2.1.321"]. Other shapes give the first word and no version.
function parseAiAgent(value) {
    const [product, version] = clean(value).split(/[_/@\s]+/);
    return [product ?? "", version && /^\d+([-.]\d+)*$/.test(version) ? version.replace(/-/g, ".") : null];
}
export function detectAgent({ env = process.env, launchPath = process.argv[1], id, name } = {}) {
    const said = clean(id) || clean(env.REFLEKTOR_AGENT);
    if (said)
        return describe(said, "flag");
    if (clean(env.AI_AGENT)) {
        const [product, version] = parseAiAgent(env.AI_AGENT);
        const found = describe(product, "env", version);
        if (found)
            return found;
    }
    for (const [agent, entry] of Object.entries(TABLE)) {
        if ((entry.env ?? []).some((marker) => clean(env[marker])))
            return describe(agent, "env");
    }
    const path = String(launchPath ?? "").replace(/\\/g, "/");
    for (const [agent, entry] of Object.entries(TABLE)) {
        if ((entry.paths ?? []).some((part) => path.includes(part)))
            return describe(agent, "path");
    }
    const own = clean(name) || clean(env.REFLEKTOR_AGENT_NAME);
    if (own) {
        const known = lookup(own);
        // A name the table knows gets the table's words; any other is shown as the agent gave it.
        return known ? describe(known, "self") : { id: key(own), name: own, product: own, resume: null, version: null, source: "self" };
    }
    return null;
}
// What a caller sent, checked before the daemon keeps it and shows it: the right fields, cleaned, or null.
export function cleanAgent(value) {
    if (!value || typeof value !== "object")
        return null;
    const sent = value;
    const name = clean(sent.name);
    if (!name)
        return null;
    return {
        id: key(sent.id) || null,
        name,
        product: clean(sent.product) || name,
        resume: clean(sent.resume) || null,
        version: clean(sent.version) || null,
    };
}
// The agent travels with each call in a header, as JSON made safe for one.
export const AGENT_HEADER = "x-reflektor-agent";
export const encodeAgent = (agent) => encodeURIComponent(JSON.stringify(agent));
export function decodeAgent(header) {
    try {
        return cleanAgent(JSON.parse(decodeURIComponent(String(header ?? ""))));
    }
    catch {
        return null;
    }
}
