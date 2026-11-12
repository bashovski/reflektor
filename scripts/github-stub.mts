// A stand-in for GitHub's REST API on a local port, for the check suites. The daemon asks it for the
// books repo's pull requests (PR_REPORT_GITHUB_API points at it), and the check scripts what it
// answers: no pull request, then an open one, then a merged one, or a rate limit. ETags work as on
// GitHub: a request whose If-None-Match names the current answer gets 304 and no body.

import { createServer } from "node:http";

// A pull request as the REST API lists it, for acme-labs/library. `merged` is the merge time.
export const githubPr = (number, state, merged = null) => ({
  number,
  html_url: `https://github.com/acme-labs/library/pull/${number}`,
  title: "Save and list books in the library",
  state,
  merged_at: merged,
  base: { ref: "main" },
});

export function startGithubStub() {
  const requests = [];
  let list = [];
  const known = new Map();
  let version = 1;
  let failNext = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const entry = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, status: 0, at: Date.now() };
    requests.push(entry);
    const reply = (status, body, headers = {}) => {
      entry.status = status;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (failNext) {
      const f = failNext;
      failNext = null;
      return reply(f.status, { message: "rate limited" }, f.headers);
    }
    const m = url.pathname.match(/^\/repos\/acme-labs\/library\/pulls(?:\/(\d+))?$/);
    if (!m) return reply(404, { message: "Not Found" });
    if (m[1]) return known.has(Number(m[1])) ? reply(200, known.get(Number(m[1]))) : reply(404, { message: "Not Found" });
    const etag = `"pulls-v${version}"`;
    if (req.headers["if-none-match"] === etag) return reply(304, undefined, { etag });
    reply(200, list, { etag });
  });
  return new Promise((resolveStub) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStub({
        url: `http://127.0.0.1:${server.address().port}`,
        // Every request so far, oldest first.
        requests,
        // What the list of the branch's pull requests answers from now on, with a new ETag.
        set(pulls) {
          list = pulls;
          version++;
          for (const pr of pulls) known.set(pr.number, pr);
        },
        // A pull request that only the single-pull-request route knows, the way the agent's URL names it.
        know(pr) {
          known.set(pr.number, pr);
        },
        // The next request, whatever it is, gets this answer.
        failNext(status, headers) {
          failNext = { status, headers };
        },
        close: () => server.close(),
      }),
    ),
  );
}
