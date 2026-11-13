// A stand-in for Reflektor's API on a local port, for the check suites: the device login, whoami, the preflight and
// the upload, as the platform's docs/reports-and-organizations.md describes them. The check scripts say what it
// answers (which organizations approve the repo, the device flow's answers one by one, a refusal for the next call),
// and read back every request it got, the upload's body unzipped.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

export type StubOrganization = { slug: string; name: string };
// An answer the stub gives: a status, a JSON body, and headers.
export type StubAnswer = { status: number; body?: unknown; headers?: Record<string, string> };

// One request the stub got. `json` is the body parsed, unzipped first when it came gzipped; `bytes` is the body as sent.
type StubRequest = { method: string; path: string; headers: IncomingHttpHeaders; bytes: Buffer; json: unknown; status: number };

export const STUB_TOKEN = "rfk_stub-token";
export const STUB_USER = { id: "usr_1", email: "ada@example.test", name: "Ada Lovelace" };
const approved: StubAnswer = { status: 200, body: { accessToken: STUB_TOKEN, tokenType: "Bearer", user: STUB_USER } };
const pending: StubAnswer = { status: 400, body: { error: "authorization_pending" } };

export type ReflektorStub = {
  url: string;
  requests: StubRequest[];
  // The uploads (POST /reports) so far, as parsed bodies.
  uploads(): { organization?: string; bundle: { diff: { branch: { snapshot: string } }; round: number; draft?: boolean } }[];
  organizations(list: StubOrganization[]): void;
  device(answers: StubAnswer[], options?: { then?: "approved" | "pending"; interval?: number; expiresIn?: number }): void;
  failNext(path: string, answer: StubAnswer): void;
  close: () => void;
};

export function startReflektorStub(): Promise<ReflektorStub> {
  const requests: StubRequest[] = [];
  let orgs: StubOrganization[] = [{ slug: "acme", name: "Acme" }];
  let deviceAnswers: StubAnswer[] = [];
  let afterAnswers = approved;
  let interval = 0;
  let expiresIn = 600;
  const failures = new Map<string, StubAnswer>();
  // Rounds per snapshot, the way the platform dedupes an upload of the same code.
  const rounds = new Map<string, number>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // A server's request always has a URL and a method.
      const url = new URL(req.url!, "http://stub");
      const bytes = Buffer.concat(chunks);
      let json: unknown = null;
      try {
        const text = (req.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8");
        json = text ? JSON.parse(text) : null;
      } catch {
        json = undefined;
      }
      const entry: StubRequest = { method: req.method!, path: url.pathname, headers: req.headers, bytes, json, status: 0 };
      requests.push(entry);
      const reply = ({ status, body, headers = {} }: StubAnswer) => {
        entry.status = status;
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const failure = failures.get(url.pathname);
      if (failure) {
        failures.delete(url.pathname);
        return reply(failure);
      }
      const signedIn = req.headers.authorization === `Bearer ${STUB_TOKEN}`;
      const route = `${req.method} ${url.pathname}`;
      if (route === "POST /auth/device") {
        const base = `http://${req.headers.host}`;
        return reply({
          status: 200,
          body: { deviceCode: "dev_1", userCode: "ABCD-EFGH", verificationUri: `${base}/device`, verificationUriComplete: `${base}/device?code=ABCD-EFGH`, expiresIn, interval },
        });
      }
      if (route === "POST /auth/device/token") return reply(deviceAnswers.shift() ?? afterAnswers);
      if (!signedIn) return reply({ status: 401, body: { error: "unauthorized" } });
      if (route === "GET /auth/me") return reply({ status: 200, body: { ...STUB_USER, avatarUrl: null } });
      if (route === "POST /reports/preflight") return reply({ status: 200, body: { organizations: orgs } });
      if (route === "POST /reports") {
        const upload = json as { organization?: string; bundle?: { diff?: { branch?: { snapshot?: string } } } } | undefined;
        const snapshot = upload?.bundle?.diff?.branch?.snapshot;
        if (!snapshot) return reply({ status: 400, body: { error: "invalid_bundle", issues: [{ path: ["bundle"], message: "Required" }] } });
        if (!orgs.length) return reply({ status: 403, body: { error: "repository_not_approved" } });
        const org = upload.organization ? orgs.find((o) => o.slug === upload.organization) : orgs.length === 1 ? orgs[0] : null;
        if (!upload.organization && !org) return reply({ status: 409, body: { error: "organization_required", organizations: orgs } });
        if (!org) return reply({ status: 403, body: { error: "not_a_member" } });
        const known = rounds.get(snapshot);
        const round = known ?? rounds.size + 1;
        rounds.set(snapshot, round);
        return reply({ status: known ? 200 : 201, body: { report: { id: "rep_1", url: `http://${req.headers.host}/${org.slug}/reports/rep_1` }, round, created: !known } });
      }
      reply({ status: 404, body: { error: "not_found" } });
    });
  });

  return new Promise((resolveStub) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStub({
        // Listening on a TCP port, so the address is an AddressInfo, not a pipe name.
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        // Every request so far, oldest first.
        requests,
        uploads: () => requests.filter((q) => q.method === "POST" && q.path === "/reports" && q.status < 300).map((q) => q.json as ReturnType<ReflektorStub["uploads"]>[number]),
        // The organizations that approve the repo, as the preflight answers from now on.
        organizations(list) {
          orgs = list;
        },
        // The answers to the device flow's polls, one each, then approved (or pending for good). Also the interval and
        // the life of the codes POST /auth/device hands out from now on.
        device(answers, options = {}) {
          deviceAnswers = [...answers];
          afterAnswers = options.then === "pending" ? pending : approved;
          interval = options.interval ?? 0;
          expiresIn = options.expiresIn ?? 600;
        },
        // The next request to this path, whatever it is, gets this answer.
        failNext(path, answer) {
          failures.set(path, answer);
        },
        close: () => server.close(),
      }),
    ),
  );
}
