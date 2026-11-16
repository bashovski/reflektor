#!/usr/bin/env bash
# Builds a small fake repo with a "books" feature branch, used to develop and test the report.
# Usage: make-books-repo.sh [target-dir]
set -euo pipefail

DIR="${1:-$(cd "$(dirname "$0")" && pwd)/.books-repo}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main
git config user.name "Sample Dev"
git config user.email "dev@example.com"
git config commit.gpgsign false

w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }
commit() { git add -A; GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }

# ---------------------------------------------------------------- main branch

w .gitignore <<'EOF'
node_modules/
coverage/
EOF

w package.json <<'EOF'
{
  "name": "library",
  "private": true,
  "packageManager": "pnpm@10.26.2"
}
EOF

w .reflektor.json <<'EOF'
{
  "base": "main",
  "targets": {
    "backend": ["apps/api/**"],
    "frontend": ["apps/web/**"],
    "database": ["db/**"],
    "infrastructure": ["infra/**", ".env.example"],
    "cicd": [".github/**"]
  },
  "coverage": {
    "command": "pnpm --filter @library/api test -- --coverage",
    "files": ["apps/api/coverage/lcov.info"]
  }
}
EOF

w pnpm-workspace.yaml <<'EOF'
packages:
  - apps/*
EOF

w pnpm-lock.yaml <<'EOF'
lockfileVersion: '9.0'

importers:
  apps/api:
    dependencies:
      express:
        specifier: ^5.1.0
        version: 5.1.0
      pg:
        specifier: ^8.16.0
        version: 8.16.3

packages:
  express@5.1.0:
    resolution: {integrity: sha512-DT9ck5YIRU+8GYzzU5kT3eHGA5iL+1Zd0EutOmTE9Dtk+Tvuzd23VBU+ec7HPNSTxXYO55gPV/hq4pSBJDjFpA==}
    engines: {node: '>= 18'}

  pg@8.16.3:
    resolution: {integrity: sha512-enxc1h0jA/aq5oSDMvqyW3q89ra6XIIDZgCX9vkMrnz5DFTw/Ny3Li2lFQ+pt3L6MCgm/5o2o8HW9hiJji+xvw==}
    engines: {node: '>= 16.0.0'}
EOF

w .env.example <<'EOF'
PORT=3000
DATABASE_URL=postgres://library:library@localhost:5432/library
SESSION_SECRET=change-me
EOF

w infra/docker-compose.yml <<'EOF'
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: library
      POSTGRES_PASSWORD: library
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports: ["5432:5432"]

  api:
    build: ../apps/api
    environment:
      DATABASE_URL: postgres://library:library@db:5432/library
      SESSION_SECRET: ${SESSION_SECRET}
    depends_on: [db]
    ports: ["3000:3000"]

volumes:
  pgdata:
EOF

w .github/workflows/ci.yml <<'EOF'
name: ci
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: library
          POSTGRES_PASSWORD: library
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @library/api test
EOF

w db/migrations/0041_create_authors.sql <<'EOF'
CREATE TABLE authors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
EOF

w apps/api/package.json <<'EOF'
{
  "name": "@library/api",
  "version": "1.4.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^5.1.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "vitest": "^3.2.0"
  }
}
EOF

w apps/api/src/server.ts <<'EOF'
import express from "express";
import { registerRoutes } from "./routes.js";
import { errorHandler } from "./shared/errorHandler.js";

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

app.listen(Number(process.env.PORT ?? 3000));
EOF

w apps/api/src/db.ts <<'EOF'
import pg from "pg";

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
EOF

w apps/api/src/routes.ts <<'EOF'
import type { Express } from "express";
import { authGuard } from "./auth/authGuard.js";
import { AuthorsController } from "./authors/authors.controller.js";

export function registerRoutes(app: Express) {
  const authors = new AuthorsController();

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/authors", authGuard, authors.list);
  app.get("/authors/:id", authGuard, authors.get);
}
EOF

w apps/api/src/auth/authGuard.ts <<'EOF'
import type { NextFunction, Request, Response } from "express";
import { verifySession } from "./session.js";

export async function authGuard(req: Request, res: Response, next: NextFunction) {
  const user = await verifySession(req.headers.authorization);
  if (!user) {
    res.status(401).json({ error: "not_logged_in" });
    return;
  }
  res.locals.user = user;
  next();
}
EOF

w apps/api/src/auth/session.ts <<'EOF'
import { db } from "../db.js";

export type SessionUser = { id: string; email: string };

export async function verifySession(header: string | undefined): Promise<SessionUser | null> {
  const token = header?.replace(/^Bearer /, "");
  if (!token) return null;
  const { rows } = await db.query(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()",
    [token],
  );
  return rows[0] ?? null;
}
EOF

w apps/api/src/shared/errors.ts <<'EOF'
export class AppError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

export class ValidationError extends AppError {
  constructor(code: string) {
    super(code, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(code: string) {
    super(code, 404);
  }
}
EOF

w apps/api/src/shared/errorHandler.ts <<'EOF'
import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal" });
}
EOF

w apps/api/src/authors/author.service.ts <<'EOF'
import { db } from "../db.js";

export type Author = { id: string; name: string };

export class AuthorService {
  async list(limit: number, offset: number): Promise<Author[]> {
    const { rows } = await db.query("SELECT id, name FROM authors ORDER BY name LIMIT $1 OFFSET $2", [limit, offset]);
    return rows;
  }

  async get(id: string): Promise<Author | null> {
    const { rows } = await db.query("SELECT id, name FROM authors WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
}
EOF

w apps/api/src/authors/authors.controller.ts <<'EOF'
import type { Request, Response } from "express";
import { AuthorService } from "./author.service.js";

export class AuthorsController {
  private service = new AuthorService();

  list = async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const authors = await this.service.list(limit, offset);
    res.json({ items: authors, limit, offset });
  };

  get = async (req: Request, res: Response) => {
    const author = await this.service.get(req.params.id);
    if (!author) {
      res.status(404).json({ error: "author_not_found" });
      return;
    }
    res.json(author);
  };
}
EOF

w apps/web/package.json <<'EOF'
{
  "name": "@library/web",
  "private": true,
  "type": "module",
  "dependencies": {
    "@tanstack/react-query": "^5.80.0",
    "axios": "^1.10.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  }
}
EOF

w apps/web/src/api/http.ts <<'EOF'
import axios from "axios";

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  withCredentials: true,
});
EOF

w apps/web/src/pages/library/AuthorList.tsx <<'EOF'
import { useQuery } from "@tanstack/react-query";
import { http } from "../../api/http";

type Author = { id: string; name: string };

export const AuthorList = () => {
  const { data: authors = [] } = useQuery({
    queryKey: ["authors"],
    queryFn: async () => (await http.get<{ items: Author[] }>("/authors")).data.items,
  });
  return (
    <ul className="divide-y rounded-lg border">
      {authors.map((author) => (
        <li key={author.id} className="p-3">{author.name}</li>
      ))}
    </ul>
  );
};
EOF

w apps/web/src/pages/library/LibraryPage.tsx <<'EOF'
import { AuthorList } from "./AuthorList";

export const LibraryPage = () => (
  <main className="mx-auto max-w-3xl p-6">
    <h1 className="text-2xl font-semibold">Library</h1>
    <AuthorList />
  </main>
);
EOF

commit "2026-10-20T09:00:00+02:00" "initial library app with authors"

git remote add origin git@github.com:acme-labs/library.git
git update-ref refs/remotes/origin/main main
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main

# ---------------------------------------------------------------- feature branch

git checkout -q -b feat/books

w db/migrations/0042_create_books.sql <<'EOF'
CREATE TABLE books (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  isbn        char(13) NOT NULL,
  author_id   uuid,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX books_owner_isbn_key ON books (owner_id, isbn);
CREATE INDEX books_owner_created_idx ON books (owner_id, created_at DESC);
EOF
commit "2026-11-02T10:12:00+01:00" "add books table migration"

w db/migrations/0043_add_author_slug.sql <<'EOF'
ALTER TABLE authors ADD COLUMN slug text NOT NULL;
CREATE UNIQUE INDEX authors_slug_key ON authors (slug);
EOF
commit "2026-11-02T10:40:00+01:00" "add author slug"

w apps/api/src/shared/pagination.ts <<'EOF'
export type Pagination = { limit: number; offset: number };

export function parsePagination(query: Record<string, unknown>): Pagination {
  const limit = Math.min(Number(query.limit ?? 20), 100);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  return { limit, offset };
}
EOF

w apps/api/src/authors/authors.controller.ts <<'EOF'
import type { Request, Response } from "express";
import { parsePagination } from "../shared/pagination.js";
import { AuthorService } from "./author.service.js";

export class AuthorsController {
  private service = new AuthorService();

  list = async (req: Request, res: Response) => {
    const { limit, offset } = parsePagination(req.query);
    const authors = await this.service.list(limit, offset);
    res.json({ items: authors, limit, offset });
  };

  get = async (req: Request, res: Response) => {
    const author = await this.service.get(req.params.id);
    if (!author) {
      res.status(404).json({ error: "author_not_found" });
      return;
    }
    res.json(author);
  };
}
EOF
commit "2026-11-02T11:40:00+01:00" "extract pagination helper"

w apps/api/src/books/book.model.ts <<'EOF'
export type Book = {
  id: string;
  title: string;
  isbn: string;
  authorId: string | null;
  ownerId: string;
  createdAt: Date;
};

export type NewBook = Pick<Book, "title" | "isbn" | "authorId" | "ownerId">;

export function toBook(row: Record<string, unknown>): Book {
  return {
    id: String(row.id),
    title: String(row.title),
    isbn: String(row.isbn),
    authorId: row.author_id ? String(row.author_id) : null,
    ownerId: String(row.owner_id),
    createdAt: new Date(String(row.created_at)),
  };
}
EOF

w apps/api/src/books/book.repository.ts <<'EOF'
import { db } from "../db.js";
import { type Book, type NewBook, toBook } from "./book.model.js";

export class BookRepository {
  async insert(book: NewBook): Promise<Book> {
    const { rows } = await db.query(
      `INSERT INTO books (title, isbn, author_id, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [book.title, book.isbn, book.authorId, book.ownerId],
    );
    return toBook(rows[0]);
  }

  async findByIsbn(ownerId: string, isbn: string): Promise<Book | null> {
    const { rows } = await db.query("SELECT * FROM books WHERE owner_id = $1 AND isbn = $2", [ownerId, isbn]);
    return rows[0] ? toBook(rows[0]) : null;
  }

  async countByOwner(ownerId: string): Promise<number> {
    const { rows } = await db.query("SELECT count(*) FROM books WHERE owner_id = $1", [ownerId]);
    return Number(rows[0].count);
  }

  async listByOwner(ownerId: string, limit: number, offset: number): Promise<Book[]> {
    const { rows } = await db.query(
      "SELECT * FROM books WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [ownerId, limit, offset],
    );
    return rows.map(toBook);
  }
}
EOF

w apps/api/src/books/book.service.ts <<'EOF'
import ISBN from "isbn3";
import { ConflictError, LimitError, ValidationError } from "../shared/errors.js";
import type { Book } from "./book.model.js";
import { BookRepository } from "./book.repository.js";

const MAX_BOOKS = Number(process.env.BOOKS_MAX_PER_USER ?? 500);

export type CreateBookInput = { title: string; isbn: string; authorId?: string };

export class BookService {
  constructor(private repo = new BookRepository()) {}

  async createBook(ownerId: string, input: CreateBookInput): Promise<Book> {
    const isbn = ISBN.asIsbn13(input.isbn);
    if (!isbn) {
      throw new ValidationError("isbn_invalid");
    }

    const existing = await this.repo.findByIsbn(ownerId, isbn);
    if (existing) {
      throw new ConflictError("book_already_saved");
    }

    const count = await this.repo.countByOwner(ownerId);
    if (count >= MAX_BOOKS) {
      throw new LimitError("book_limit_reached");
    }

    return this.repo.insert({
      title: input.title.trim(),
      isbn,
      authorId: input.authorId ?? null,
      ownerId,
    });
  }

  listBooks(ownerId: string, limit: number, offset: number): Promise<Book[]> {
    return this.repo.listByOwner(ownerId, limit, offset);
  }
}
EOF

w apps/api/src/books/books.controller.ts <<'EOF'
import type { Request, Response } from "express";
import { z } from "zod";
import { ValidationError } from "../shared/errors.js";
import { parsePagination } from "../shared/pagination.js";
import { BookService } from "./book.service.js";

const CreateBookBody = z.object({
  title: z.string().trim().min(1).max(300),
  isbn: z.string().min(10).max(17),
  authorId: z.string().uuid().optional(),
});

export class BooksController {
  private service = new BookService();

  create = async (req: Request, res: Response) => {
    const body = CreateBookBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError("body_invalid");
    }
    const book = await this.service.createBook(res.locals.user.id, body.data);
    res.status(201).json(book);
  };

  list = async (req: Request, res: Response) => {
    const { limit, offset } = parsePagination(req.query);
    const books = await this.service.listBooks(res.locals.user.id, limit, offset);
    res.json({ items: books, limit, offset });
  };
}
EOF

w apps/api/src/shared/errors.ts <<'EOF'
export class AppError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

export class ValidationError extends AppError {
  constructor(code: string) {
    super(code, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(code: string) {
    super(code, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string) {
    super(code, 409);
  }
}

export class LimitError extends AppError {
  constructor(code: string) {
    super(code, 422);
  }
}
EOF

w apps/api/src/routes.ts <<'EOF'
import type { Express } from "express";
import { authGuard } from "./auth/authGuard.js";
import { AuthorsController } from "./authors/authors.controller.js";
import { BooksController } from "./books/books.controller.js";

export function registerRoutes(app: Express) {
  const authors = new AuthorsController();
  const books = new BooksController();

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/authors", authGuard, authors.list);
  app.get("/authors/:id", authGuard, authors.get);

  app.get("/books", authGuard, books.list);
  app.post("/books", authGuard, books.create);
}
EOF

w apps/api/package.json <<'EOF'
{
  "name": "@library/api",
  "version": "1.4.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "migrate": "node-pg-migrate up -m ../../db/migrations",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^5.1.0",
    "isbn3": "^1.2.0",
    "pg": "^8.16.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "node-pg-migrate": "^8.0.0",
    "tsx": "^4.20.0",
    "vitest": "^3.2.0"
  }
}
EOF

w pnpm-lock.yaml <<'EOF'
lockfileVersion: '9.0'

importers:
  apps/api:
    dependencies:
      express:
        specifier: ^5.1.0
        version: 5.1.0
      isbn3:
        specifier: ^1.2.0
        version: 1.2.8
      pg:
        specifier: ^8.16.0
        version: 8.16.3
      zod:
        specifier: ^4.1.0
        version: 4.1.12
    devDependencies:
      node-pg-migrate:
        specifier: ^8.0.0
        version: 8.0.3

packages:
  express@5.1.0:
    resolution: {integrity: sha512-DT9ck5YIRU+8GYzzU5kT3eHGA5iL+1Zd0EutOmTE9Dtk+Tvuzd23VBU+ec7HPNSTxXYO55gPV/hq4pSBJDjFpA==}
    engines: {node: '>= 18'}

  isbn3@1.2.8:
    resolution: {integrity: sha512-Fz6cXyBHnD2C1MzRSgKu1UJbg0ZQs6Q0Y9q0E9y6mJcN9H8eFvJvYjZp8u3xU1r1D0rBqgQ2m3d1nS3bQ0p0wQ==}

  node-pg-migrate@8.0.3:
    resolution: {integrity: sha512-oKzZ4m1wq0J3pQe1Q2sQ0xg8n9rXz1o5kP1yHn2c3vS2bW2k1b8VtQz9GQb0Yq3gJ8r7mJv1oN0zJp1sY5XxkA==}
    engines: {node: '>=20.11.0'}

  pg@8.16.3:
    resolution: {integrity: sha512-enxc1h0jA/aq5oSDMvqyW3q89ra6XIIDZgCX9vkMrnz5DFTw/Ny3Li2lFQ+pt3L6MCgm/5o2o8HW9hiJji+xvw==}
    engines: {node: '>= 16.0.0'}

  zod@4.1.12:
    resolution: {integrity: sha512-JInaHOamG8mt0lEu2vaJ7bG0b/3yR0Q2vb1a1yJ1h1Jk8sXqA8w7u0vV1HnC3kQ0wV0iKz5yX9W8Gm1n6Z1p8A==}
EOF
commit "2026-11-02T15:05:00+01:00" "books api: model, repository, service, controller"

w .env.example <<'EOF'
PORT=3000
DATABASE_URL=postgres://library:library@localhost:5432/library
SESSION_SECRET=change-me
# Max books one user can save. Default 500.
BOOKS_MAX_PER_USER=500
EOF

w infra/docker-compose.yml <<'EOF'
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: library
      POSTGRES_PASSWORD: library
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports: ["5432:5432"]

  api:
    build: ../apps/api
    environment:
      DATABASE_URL: postgres://library:library@db:5432/library
      SESSION_SECRET: ${SESSION_SECRET}
      BOOKS_MAX_PER_USER: ${BOOKS_MAX_PER_USER:-500}
    depends_on: [db]
    ports: ["3000:3000"]

volumes:
  pgdata:
EOF
commit "2026-11-03T09:20:00+01:00" "book limit env var, compose update"

w apps/web/src/api/books.ts <<'EOF'
import { http } from "./http";

export type Book = { id: string; title: string; isbn: string; authorId: string | null; createdAt: string };
export type CreateBookInput = { title: string; isbn: string; authorId?: string };

export const createBook = async (input: CreateBookInput) => {
  const { data } = await http.post<Book>("/books", input);
  return data;
};

export const listBooks = async () => {
  const { data } = await http.get<{ items: Book[] }>("/books");
  return data.items;
};
EOF

w apps/web/src/hooks/useCreateBook.ts <<'EOF'
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createBook } from "../api/books";

export const useCreateBook = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createBook,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
  });
};
EOF

w apps/web/src/pages/library/AddBookForm.tsx <<'EOF'
import { type FormEvent, useState } from "react";
import { useCreateBook } from "../../hooks/useCreateBook";

const messages: Record<string, string> = {
  book_already_saved: "You already saved this book.",
  isbn_invalid: "This ISBN is not valid.",
  book_limit_reached: "You reached the book limit.",
};

export const AddBookForm = () => {
  const [title, setTitle] = useState("");
  const [isbn, setIsbn] = useState("");
  const createBook = useCreateBook();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createBook.mutate(
      { title, isbn },
      {
        onSuccess: () => {
          setTitle("");
          setIsbn("");
        },
      },
    );
  };

  const errorCode = (createBook.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 className="font-medium">Add a book</h2>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" required />
      <input value={isbn} onChange={(e) => setIsbn(e.target.value)} placeholder="ISBN" required />
      {errorCode && <p className="text-sm text-red-600">{messages[errorCode] ?? "Could not save the book."}</p>}
      <button type="submit" disabled={createBook.isPending}>
        {createBook.isPending ? "Saving..." : "Save"}
      </button>
    </form>
  );
};
EOF

w apps/web/src/pages/library/LibraryPage.tsx <<'EOF'
import { AddBookForm } from "./AddBookForm";
import { AuthorList } from "./AuthorList";

export const LibraryPage = () => (
  <main className="mx-auto max-w-3xl space-y-8 p-6">
    <h1 className="text-2xl font-semibold">Library</h1>
    <AddBookForm />
    <AuthorList />
  </main>
);
EOF
commit "2026-11-03T13:45:00+01:00" "web: add book form on library page"

w .github/workflows/ci.yml <<'EOF'
name: ci
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: library
          POSTGRES_PASSWORD: library
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @library/api migrate
        env:
          DATABASE_URL: postgres://library:library@localhost:5432/library
      - run: pnpm --filter @library/api test -- --coverage
EOF
commit "2026-11-03T16:10:00+01:00" "ci: run migrations before tests"

w apps/api/src/books/book.service.test.ts <<'EOF'
import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { BookService } from "./book.service.js";

function fakeRepo(overrides = {}) {
  return {
    findByIsbn: vi.fn().mockResolvedValue(null),
    countByOwner: vi.fn().mockResolvedValue(0),
    insert: vi.fn().mockImplementation(async (b) => ({ id: "b1", createdAt: new Date(), ...b })),
    listByOwner: vi.fn(),
    ...overrides,
  };
}

describe("BookService.createBook", () => {
  it("saves a book with a normalized ISBN-13", async () => {
    const service = new BookService(fakeRepo() as never);
    const book = await service.createBook("u1", { title: " Dune ", isbn: "0441013597" });
    expect(book.isbn).toBe("9780441013593");
    expect(book.title).toBe("Dune");
  });

  it("rejects an invalid ISBN", async () => {
    const service = new BookService(fakeRepo() as never);
    await expect(service.createBook("u1", { title: "X", isbn: "123" })).rejects.toThrow(ValidationError);
  });

  it("rejects a book the user already saved", async () => {
    const repo = fakeRepo({ findByIsbn: vi.fn().mockResolvedValue({ id: "b0" }) });
    const service = new BookService(repo as never);
    await expect(service.createBook("u1", { title: "Dune", isbn: "0441013597" })).rejects.toThrow(ConflictError);
  });
});
EOF
commit "2026-11-04T08:55:00+01:00" "tests for book service"

# ---------------------------------------------------------------- uncommitted work

w apps/web/src/pages/library/BookList.tsx <<'EOF'
import { useQuery } from "@tanstack/react-query";
import { listBooks } from "../../api/books";

export const BookList = () => {
  const { data: books = [], isLoading } = useQuery({ queryKey: ["books"], queryFn: listBooks });
  if (isLoading) return <p>Loading books...</p>;
  if (books.length === 0) return <p className="text-gray-500">No books yet.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {books.map((book) => (
        <li key={book.id} className="flex justify-between p-3">
          <span>{book.title}</span>
          <span className="font-mono text-sm text-gray-500">{book.isbn}</span>
        </li>
      ))}
    </ul>
  );
};
EOF

w apps/web/src/pages/library/LibraryPage.tsx <<'EOF'
import { AddBookForm } from "./AddBookForm";
import { AuthorList } from "./AuthorList";
import { BookList } from "./BookList";

export const LibraryPage = () => (
  <main className="mx-auto max-w-3xl space-y-8 p-6">
    <h1 className="text-2xl font-semibold">Library</h1>
    <AddBookForm />
    <BookList />
    <AuthorList />
  </main>
);
EOF

# ---------------------------------------------------------------- fake coverage (lcov)
# Marks "executable" lines as hit, except lines matching a per-file "missed" pattern.

node - "$DIR" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const rules = {
  "apps/api/src/books/book.service.ts": { missed: /LimitError\("book_limit_reached"\)|listByOwner\(ownerId, limit, offset\)/ },
  "apps/api/src/books/book.model.ts": { missed: null },
  "apps/api/src/books/books.controller.ts": { missed: /./ },
  "apps/api/src/books/book.repository.ts": { missed: /./ },
  "apps/api/src/shared/errors.ts": { missed: /super\(code, 422\)/ },
  "apps/api/src/shared/pagination.ts": { missed: null },
  "apps/api/src/authors/authors.controller.ts": { missed: /author_not_found/ },
  "apps/api/src/routes.ts": { missed: /./ },
};
const skip = /^\s*($|\/\/|import |export type |type |[})\]];?,?$|\}\)?;?$)/;
let out = "TN:\n";
for (const [file, rule] of Object.entries(rules)) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  out += `SF:${file.replace(/^apps\/api\//, "")}\n`;
  lines.forEach((text, i) => {
    if (skip.test(text)) return;
    const hit = rule.missed && rule.missed.test(text) ? 0 : 1;
    out += `DA:${i + 1},${hit}\n`;
  });
  out += "end_of_record\n";
}
fs.mkdirSync(path.join(root, "apps/api/coverage"), { recursive: true });
fs.writeFileSync(path.join(root, "apps/api/coverage/lcov.info"), out);
EOF

echo "Sample repo ready: $DIR"
git log --oneline main..HEAD
git status --short
