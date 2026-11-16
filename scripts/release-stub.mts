#!/usr/bin/env node
// A stand-in for the place releases are published, on a local port: it serves a folder pack-release.mts wrote
// (manifest.json, its signature, the tarball, the installers) the way GitHub's releases/latest/download/ does. The
// check suite starts it in-process; `pnpm release:stub [folder]` runs it by hand, for trying an install or an update:
//
//   pnpm release:pack -- --dev      (or pack-release.mjs --dev --version 0.9.1 for a newer one)
//   pnpm release:stub
//   PR_REPORT_RELEASES_URL=http://127.0.0.1:<port> ./install.sh
//
// DEV_PRIVATE_KEY signs those releases. It is public on purpose: only builds from a checkout trust its public half
// (DEV_KEY in skill/scripts/release.mts), so nothing it signs can be installed over a real release.

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./paths.mjs";

export const DEV_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIHrm4hLv5NYWwYODg0wq69nTJ4qPd4wS7oKIXeALk41g";

export type ReleaseStub = { url: string; server: Server; requests: string[]; close: () => Promise<void> };

export function startReleaseStub(folder: string): Promise<ReleaseStub> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\/+/, ""));
    requests.push(name);
    const file = join(folder, name);
    if (!name || name.includes("/") || name.includes("..") || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ url: `http://127.0.0.1:${port}`, server, requests, close: () => new Promise((closed) => server.close(() => closed())) });
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] ?? join(root, "dist", "release"));
  if (!existsSync(join(folder, "manifest.json"))) {
    console.error(`error: ${folder} has no manifest.json. Run pnpm release:pack -- --dev first.`);
    process.exit(1);
  }
  const stub = await startReleaseStub(folder);
  console.log(`Serving the release in ${folder} at ${stub.url}`);
  console.log(`Install it with: PR_REPORT_RELEASES_URL=${stub.url} ./install.sh`);
}
