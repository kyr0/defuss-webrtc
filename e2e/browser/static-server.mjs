// Serves the docs chat app for the browser tests: docs/ at "/", and the freshly
// built library (./dist) at "/dist/" instead of the vendored docs/dist copy, so
// the tests always exercise the current source.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const docs = join(root, "docs");
const dist = join(root, "dist");
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function resolve(pathname) {
  const [base, rest] = pathname.startsWith("/dist/") ? [dist, pathname.slice(6)] : [docs, pathname.slice(1) || "index.html"];
  const file = normalize(join(base, decodeURIComponent(rest)));
  return file === base || file.startsWith(base + sep) ? file : null; // no path traversal
}

createServer(async (req, res) => {
  const file = resolve(new URL(req.url, "http://x").pathname);
  const info = file && (await stat(file).catch(() => null));
  if (!info?.isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`docs on http://127.0.0.1:${port}`));
