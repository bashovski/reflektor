# Roadmap

## Done

- PR description from the report
- Secret and migration checks
- Plan check: did the change do what the session planned
- Project checks: run the repo's lint, typecheck and test commands
- Schema diagram for database changes
- Live questions while reviewing

## Later (remind)

- **Before/after screenshots** of changed UI pages, when Playwright and a dev server are available.
- **Tests on other stacks:** fake repos in Go, Python and Rust run by `pnpm check`, to prove the skill works for any stack.
- **Smaller reports:** embed only the syntax grammars the diff uses (about 12 MB down to about 2 MB).

## Open decisions

- **Dependency check:** Claude lists changed packages, OSV.dev and deps.dev supply versions, vulnerabilities and licenses. Waiting on answers about scope, online lookups, blocking, and release age.
- **"Do this" on before-merge items Claude cannot do** (run a production migration, set a production env var): show "Got it" instead.
- **Duplicate items:** the same task can appear as a highlight and as a before-merge item.

## Not now

- Sharing reports with teammates (link, CI artifact, PR comments). Held back while this is planned as a product.

## Before selling

- Add a third-party notices file. The page bundles @pierre/diffs (Apache-2.0), React, Tailwind and atom-material-icons (MIT), Lucide (ISC) and the Geist fonts (OFL-1.1). Apache-2.0 and MIT require shipping their license texts.
