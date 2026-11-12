# Subagent mode

collect.mts sends you here when the reader has turned on Subagentic Mode in the page's Settings: they want the report sooner and accept that it costs more tokens. The steps named below are the ones in SKILL.md.

This replaces the reading of step 4 and the writing of step 5. Use it only when both of these hold, and go on with step 4 as usual otherwise:

- You can start subagents that run at the same time (in Claude Code, the Agent tool).
- The change is big enough to split: 3 or more sections with files to read, or about 400 changed lines.

Then:

1. From collect's file table, put every file in a section and give each section its review level, as step 5 describes. Do not read the diffs yourself.
2. Start one subagent for each section, all in one message so they run together. Put small sections that belong together into one subagent. Write sections that hold only generated or lock files yourself. At most 8 subagents.
3. A subagent knows nothing of this conversation, so tell it:
   - the repo path, its files, and the `git diff` command collect printed, to run for those files only
   - why the change was made, in two or three sentences, and the plan's items if there was a plan
   - the coverage lines and the safety findings collect printed for its files
   - to read `schema/types.ts` and `style-guide.md` first, by the full paths step 5 gives, and to search the repo for callers of what its files change
   - what to send back, as JSON and nothing else: `section` (a `Section` with its highlights, questions and files, as step 5 describes), `contracts`, `schema` tables, `beforeMerge` items, `gaps` in testing, and `steps`: the entry points and calls in its files that a flow would show, each with `symbol`, `ref` and one line on what it does
   - what not to do: change code, run tests or write files
4. While they work, write the header and the plan check yourself.
5. When all have answered, put report.json together as step 5 describes: its section order and its limits, with doubles removed from the contracts and the schema tables. Write the flows yourself from the `steps` the subagents sent, since a flow crosses sections. Then go on with step 6.

If a subagent fails or sends something you cannot use, do its section yourself.
