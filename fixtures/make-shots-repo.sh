#!/usr/bin/env bash
# Builds a small fake app with a sign-in page and a "feat/add-book" branch that adds a dialog, used to test
# screenshots.mjs. The app is one Node file with no packages; PORT says where it listens.
# Usage: make-shots-repo.sh <target-dir>
set -euo pipefail

DIR="$1"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main
git config user.name "Sample Dev"
git config user.email "dev@example.com"
git config commit.gpgsign false

cat > server.mjs <<'EOF'
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const port = Number(process.env.PORT ?? 4317);
const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>body{font:16px sans-serif;margin:40px}</style></head><body>${body}</body></html>`;
const html = (res, title, body) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(title, body));
};
createServer((req, res) => {
  const signedIn = (req.headers.cookie ?? "").includes("session=ok");
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const ok = form.get("email") === "tester@example.test" && form.get("password") === "secret";
      res.writeHead(302, ok ? { "set-cookie": "session=ok; Path=/", location: "/books" } : { location: "/login" });
      res.end();
    });
    return;
  }
  if (url.pathname === "/login") return html(res, "Sign in", `<h1>Sign in</h1><form method="post"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`);
  if (url.pathname === "/books") {
    if (!signedIn) {
      res.writeHead(302, { location: "/login" });
      return res.end();
    }
    return html(res, "Books", readFileSync(new URL("./books.html", import.meta.url), "utf8"));
  }
  html(res, "Home", `<h1>Bookshelf</h1><a href="/books">Your books</a>`);
}).listen(port, "127.0.0.1");
EOF

cat > books.html <<'EOF'
<h1>Your books</h1>
<ul><li>Dune</li><li>Neuromancer</li></ul>
EOF

cat > package.json <<'EOF'
{ "name": "bookshelf", "private": true, "scripts": { "dev": "node server.mjs" } }
EOF
git add -A
git commit -q -m "Bookshelf"

git checkout -q -b feat/add-book
cat > books.html <<'EOF'
<h1>Your books</h1>
<button onclick="document.getElementById('dlg').hidden=false">Add book</button>
<ul><li>Dune</li><li>Neuromancer</li></ul>
<div id="dlg" role="dialog" aria-label="Add a book" hidden><label>Title <input name="title"></label><button onclick="const li=document.createElement('li');li.textContent=document.querySelector('[name=title]').value;document.querySelector('ul').append(li);document.getElementById('dlg').hidden=true">Save</button></div>
EOF
mkdir -p scripts
cat > scripts/e2e-login.sh <<'EOF'
#!/bin/sh
printf '{"username":"tester@example.test","password":"secret"}' > "$PR_REPORT_AUTH_CREDENTIALS"
EOF
git add -A
git commit -q -m "Add a book from the list"
