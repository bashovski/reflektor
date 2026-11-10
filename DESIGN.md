# Design rules

How the review page (`viewer/`) and the inbox (`skill/scripts/daemon.mjs`) look, and where each rule lives in the code. New work stays inside these rules. To change the look, change the rule here and in the place it names, not in single components.

These rules cover surface style only. The layout and the order of things on the page are not part of them.

## Shapes

- **Blocks are square and flat.** A block is anything that sits on the page: a section, a file, the plan check. It takes `surface border`: a hairline border, no rounding, no shadow.
- **Controls have 2px corners.** Buttons, inputs, badges, menus, dialogs, comment boxes and code chips take `rounded-control`. The size is set once, as `--radius-control` in `viewer/src/index.css`.
- **Round is for dots.** Only status dots, avatars of people and number marks are circles.
- **One shadow.** Only things that float over the page (menus, dialogs, the review bar) have a shadow, and it is always `shadow-float`, set as `--shadow-float` in `index.css`.

## Type

- **Sans for reading.** Titles, sentences and anything a person or the agent wrote are in Geist.
- **Mono capitals for the interface's own words.** Group headings, badges and status words take `label-caps`.
- **Mono for figures.** A count, a share, a duration or a date takes `num`. Only the figure takes it, not the words around it.
- **Mono for code.** Paths, branch names, commit ids and symbols take `font-mono`.

## Color

A color that carries a meaning is written by its role, never by its hue. The roles are full color scales defined in `index.css`, so they take the usual shade numbers: `text-danger-600 dark:text-danger-400`, `bg-ok-500/10`.

| Role | Means | Hue today |
| --- | --- | --- |
| `danger` | Something is wrong, or must be read | red |
| `warn` | Needs a look: changed, unsure, not decided | amber |
| `ok` | Done, passed, new | emerald |
| `accent` | What you can act on: main buttons, links, focus, your own comments | blue |
| `agent` | The agent's side: its work in progress, its questions and answers | violet |

- **Greys are zinc.** The page itself is colored by the tokens `--bg`, `--surface`, `--surface-2`, `--border`, `--text` and `--muted`, which change with the theme.
- **Category colors are not roles.** A color that only tells categories apart keeps its hue, so retuning a role never moves it: the targets, the PR type tags, the highlight kinds that are not a warning, and the pull request states, which are GitHub's own colors. They live in `viewer/src/lib/meta.ts`.
- **Color is never the only signal.** A status shows a word or an icon next to its color.

## Meters

Progress is drawn with `Meter` (`viewer/src/components/ui.tsx`): a row of square cells, one for each thing while there are few, with the figure written next to it.

## The inbox

The inbox is plain CSS inside `skill/scripts/daemon.mjs` and cannot use the classes above. It follows the same rules by hand: 2px corners, mono capitals for labels, mono figures and the same shadow for menus. A change to a rule here needs the same change there.
