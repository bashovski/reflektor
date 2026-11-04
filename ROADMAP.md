# Roadmap

## Done

- PR description from the report
- Secret and migration checks
- Plan check: did the change do what the session planned
- Project checks: run the repo's lint, typecheck and test commands
- Schema diagram for database changes
- Live questions while reviewing
- Review daemon: one address for every review, an inbox, live plan, live progress per comment, new rounds as a banner
- Speed: diffs render only near the screen, code colored with WebAssembly lexers, the daemon serves the viewer as cached files and each report is only its data (44-file change: 2.4 s frozen and 161 MB before, under 0.3 s and 37 MB after)

## Later (remind)

- **Before/after screenshots** of changed UI pages, when Playwright and a dev server are available.
- **Tests on other stacks:** fake repos in Go, Python and Rust run by `pnpm check`, to prove the skill works for any stack.
- **Smaller exported pages:** `build.mjs --html` still writes about 11 MB, almost all of it Shiki grammars kept as a fallback for browsers without WebAssembly. Drop them, or embed only the languages the diff uses. Reports opened through the daemon are not affected.

## Open decisions

- **Dependency check:** Claude lists changed packages, OSV.dev and deps.dev supply versions, vulnerabilities and licenses. Waiting on answers about scope, online lookups, blocking, and release age.
- **"Do this" on before-merge items Claude cannot do** (run a production migration, set a production env var): show "Got it" instead.
- **Duplicate items:** the same task can appear as a highlight and as a before-merge item.

## Not now

- Sharing reports with teammates (link, CI artifact, PR comments). Held back while this is planned as a product.

## Before selling

- Add a third-party notices file. The page bundles @pierre/diffs (Apache-2.0), React, Tailwind and atom-material-icons (MIT), Lucide (ISC) and the Geist fonts (OFL-1.1). Apache-2.0 and MIT require shipping their license texts.
