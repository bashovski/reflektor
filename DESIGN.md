# Design rules

How the review page (`viewer/`) and the inbox (`skill/scripts/daemon.mjs`) look, and where each rule lives in the code. New work stays inside these rules. To change the look, change the rule here and in the place it names, not in single components.

These rules cover surface style only. The layout and the order of things on the page are not part of them.

## Shapes

- **Blocks are square and flat.** A block is anything that sits on the page: a section, a file, the plan check. It takes `surface border`: a hairline border, no rounding, no shadow.
- **Controls have 2px corners.** Buttons, inputs, badges, menus, dialogs, comment boxes and code chips take `rounded-control`. The size is set once, as `--radius-control` in `viewer/src/index.css`.
- **Round is for dots.** Only status dots, the nodes of a flow and avatars of people are circles. A number mark, like the step numbers in the review path, is a small square with the control corner.
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
| `accent` | What you can act on: main buttons, the selected choice, focus, your own comments | none: white in the dark theme, near-black in the light one |
| `agent` | The agent's side: its work in progress, its questions and answers | violet |

- **The accent has no hue.** It is the color of the text itself, set as `--accent` in `index.css`, with `--on-accent` for what sits on it. A main button is `bg-accent text-on-accent`. It is one color and not a scale, so a tint is written with an opacity, as in `bg-accent/10`. A link is underlined, because its color no longer sets it apart.
- **Greys are zinc.** The page itself is colored by the tokens `--bg`, `--surface`, `--surface-2` and `--border`, which change with the theme.
- **Text has three tones.** What you read is `--text`. What explains it (descriptions, labels, notes) takes `text-muted`, which keeps at least 4.5 to 1 against a block in both themes. What can be missed (separators, icons, small counts) takes `text-faint`, at about 3.8 to 1. Do not write a single zinc shade for text: it is the same grey in both themes, so it is too dim in one of them.
- **Category colors are not roles.** A color that only tells categories apart keeps its hue, so retuning a role never moves it: the targets, the PR type tags, the highlight kinds that are not a warning, and the pull request states, which are GitHub's own colors. They live in `viewer/src/lib/meta.ts`.
- **Color is never the only signal.** A status shows a word or an icon next to its color.

## Focus and motion

- **One focus ring.** Everything you can tab to shows a 2px ring in the accent color, for the keyboard only. It is set once in `index.css`. A field that marks focus with its border turns the ring off with `outline-none`.
- **Motion is optional.** When the system asks for less motion, nothing rises, flashes or spins, and scrolling from a click is instant. New animations go through the same rule in `index.css`, and a scroll started from code asks `scrollBehavior()` in `viewer/src/lib/motion.ts`.

## The setup wizard

The setup wizard is the one page with a decorative background: slow dithered waves behind the card, drawn by `Dither` (`viewer/src/vendor/react-bits/Dither.tsx`, copied from React Bits). Its settings and its shades for each theme are in `viewer/src/components/SetupSteps.tsx`: mostly the page's own greys, with color only on the waves. It stops by itself when the system asks for less motion. The review page and the inbox have no background of this kind.

## Meters

Progress is drawn with `Meter` (`viewer/src/components/ui.tsx`): a row of square cells, one for each thing while there are few, with the figure written next to it.

## Files

A file's name or path that you can click shows the file's type icon before it, drawn by `FileIcon` (`viewer/src/components/ui.tsx`). The link to a file and line is always `RefLink` from the same file, which has the icon built in.

## The inbox

Settings, Help and the cache purge are not written twice. The inbox shows the report's own dialogs, from the page at `/panel`, in a see-through frame over itself (`viewer/src/lib/panel.ts`). The menu that opens them is written by hand in both places, so a change to one menu needs the same change to the other.

The inbox is plain CSS inside `skill/scripts/daemon.mjs` and cannot use the classes above. It is laid out like a report: the same top bar (the mark on the left, the star link and the reader's menu on the right, with the same options in the menu), the same page width of 1440px with the same side padding, the same setup banner under the bar, and a page title at the size of a report's title. It follows the same rules by hand: 2px corners, mono capitals for labels and status words, mono for figures and branch names, the same focus ring and the same shadow for menus. A change to a rule here needs the same change there.
