# Writing style for PR reports

Readers include non-native English speakers. Write so a tired reader understands each line on the first pass.

## Sentences

- Keep sentences under 20 words, with one idea each.
- Use common words. Tech terms like endpoint, migration, index or cache are fine. Explain a rare term once, in brackets.
- Use active voice with a clear actor: "The API now rejects empty titles."
- Say what changed, then why. Skip how it works when the code already shows it.
- No idioms ("under the hood", "low-hanging fruit").
- No marketing words: robust, seamless, leverage, enhance, streamline, powerful, comprehensive.

## Lists

When text names two or more things that each get their own explanation, use a bullet list instead of one long sentence.

- Start with a short lead-in line that ends with a colon.
- Put one thing per bullet.
- Bold the name of the thing: the package, endpoint, field, file, status code or step.
- Use a numbered list only when order matters, for example the steps a function runs.

Bad:

```
New: zod (checks request bodies) and isbn3 (checks and converts ISBNs) at runtime, node-pg-migrate (runs SQL migrations) for dev and CI.
```

Good:

```
New packages:
- **zod** (checks request bodies), used at runtime
- **isbn3** (checks and converts ISBNs), used at runtime
- **node-pg-migrate** (runs SQL migrations), dev and CI only
```

Keep two short items without explanations in a sentence: "Adds GET /books and POST /books."

## Names in sentences

Inside a sentence, write exact identifiers as `code`: env vars, function and file names, commands, status codes like `409`. People search for these. Bold is only for the name at the start of a list item.

## Formatting you can use

Every text field in report.json (highlights, notes, line notes, flow details, questions, before-merge items, test gaps) supports this small Markdown subset and nothing else:

| Write | Shows as |
|---|---|
| `**name**` | bold |
| `` `code` `` | inline code |
| `- item` on its own line | bullet list |
| `1. item` on its own line | numbered list |
| a blank line | new paragraph |

Separate lines with `\n` inside the JSON string. Do not use headings, links, tables or HTML. The title and summary stay plain text.
