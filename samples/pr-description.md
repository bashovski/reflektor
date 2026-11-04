[FEATURE] Save and list books in the library (new books table, POST and GET /books)

## Summary

Users can now add a book on the Library page and see the books they saved. The API stores books in a new books table and blocks one user from saving the same ISBN twice.

**Areas:** Backend, Frontend, Database, Infrastructure, CI/CD · **Size:** 20 files, +314 −6 · **Review time:** about 15 min

## What changed

- **Database** (1 file): New table books. One user cannot save the same ISBN twice (unique index on owner_id + isbn).
- **Infrastructure** (1 file): The API container gets BOOKS_MAX_PER_USER, default 500.
- **Backend** (6 files): Two new endpoints, both for logged-in users only: **POST /books** saves a book; **GET /books** lists the user's books, newest first, 20 per page
- **CI/CD** (1 file): Migrations run against the CI database before tests.
- **Config** (1 file): New optional env var BOOKS_MAX_PER_USER. The code uses 500 when it is missing.
- **Dependencies** (1 file): New packages: **zod** (checks request bodies), used at runtime; **isbn3** (checks and converts ISBNs), used at runtime; **node-pg-migrate** (runs SQL migrations), dev and CI only
- **Frontend** (5 files): /library now shows an Add book form and the user's book list.
- **Tests** (1 file): Tests cover: a valid save; an invalid ISBN; a duplicate ISBN
- **Refactors** (2 files): No behavior change. Same paging rules (default 20, max 100), now shared by authors and books.

## Before you merge

- [ ] Run migration 0042 before the new API code goes live. Without the books table, both /books endpoints return 500.
- [ ] Commit BookList.tsx and the LibraryPage.tsx change. They exist only on your machine.
- [ ] Add @vitest/coverage-v8 to apps/api devDependencies, or remove --coverage from CI. Otherwise CI fails.
- [ ] Optional: set BOOKS_MAX_PER_USER in production if 500 books per user is not the right limit.

## Risks

- author_id has no foreign key. Deleting an author leaves books that point to nothing. (`db/migrations/0042_create_books.sql:5`)
- Local Postgres goes from 16 to 17. Existing pgdata volumes were made by 16 and will not start on 17 without a dump and restore. (`infra/docker-compose.yml:3`)
- Two saves at the same moment both pass the duplicate check. The database rejects one, and that user gets 500 instead of 409. (`apps/api/src/books/book.service.ts:19`)
- Tests now run with --coverage, but @vitest/coverage-v8 is not in devDependencies. Vitest stops with a missing dependency error, so CI goes red. (`.github/workflows/ci.yml:21`)
- Two requests at the same moment can both pass the ISBN check. The database then rejects one with a raw error → 500, not 409. (`apps/api/src/books/book.service.ts:13`)

## Testing

- Tests run 51% of the new lines (42 of 83).
- Not tested: No test for the book limit. The LimitError line never runs in tests.
- Not tested: BooksController and BookRepository have no tests. Body checks and SQL are untested.
- Not tested: No test for two saves of the same ISBN at the same moment.

<sub>Written from a pr-report review report.</sub>
