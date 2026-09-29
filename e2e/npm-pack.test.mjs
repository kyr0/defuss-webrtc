// End-to-end test for the published package shape: builds dist, runs `npm pack`,
// installs the tarball into a throwaway consumer project and verifies that all
// three entry points ("defuss-webrtc", "defuss-webrtc/webrtc", "defuss-webrtc/crdt")
// import and work under plain Node — at runtime (node) and at type level (tsc).
//
// Run with: npm run test:e2e   (this file is picked up by the e2e/*.test.mjs glob)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSC = join(ROOT, "node_modules", ".bin", "tsc");
const EXEC_TIMEOUT = 120_000;

let work; // temp dir holding the tarball and the consumer project
let tarball;

const npm = (args, cwd) =>
  execFileSync("npm", args, { cwd, encoding: "utf8", timeout: EXEC_TIMEOUT, stdio: ["ignore", "pipe", "inherit"] }).trim();

before(() => {
  work = mkdtempSync(join(tmpdir(), "defuss-webrtc-pack-"));
  // Pack exactly what `npm publish` would ship.
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], timeout: EXEC_TIMEOUT });
  tarball = join(work, npm(["pack", ROOT, "--pack-destination", work], work).split("\n").at(-1));
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("npm pack tarball", () => {
  test("contains the runtime, types and docs — and nothing else", () => {
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
    const files = entries.map((entry) => entry.replace(/^package\//, ""));

    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/webrtc/index.js",
      "dist/webrtc/index.d.ts",
      "dist/crdt/index.js",
      "dist/crdt/index.d.ts",
    ]) {
      assert.ok(files.includes(required), `tarball is missing ${required}`);
    }
    assert.ok(files.every((file) => /^(dist\/|README\.md$|SKILL\.md$|ARCH\.md$|LICENSE$|package\.json$)/.test(file)),
      `unexpected files in tarball: ${files.join(", ")}`);
    assert.ok(!files.some((file) => /^(src|tests|e2e|server|vercel|docs|node_modules)\//.test(file)), "sources or dev files leaked into the tarball");
  });

  test("package.json exports point at files that exist in the tarball", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    for (const [subpath, conditions] of Object.entries(manifest.exports)) {
      for (const target of Object.values(conditions)) {
        assert.ok(entries.includes(`package/${target.slice(2)}`), `exports["${subpath}"] target ${target} is not in the tarball`);
      }
    }
  });
});

describe("consumer project (npm install <tarball>)", () => {
  let consumer;

  before(() => {
    consumer = mkdtempSync(join(work, "consumer-"));
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", type: "module" }), null);
    npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);
  });

  test("ESM imports resolve and the API works at runtime", () => {
    writeFileSync(
      join(consumer, "smoke.mjs"),
      `import assert from "node:assert/strict";
import { randomId, assertJsonValue, stableStringify } from "defuss-webrtc";
import { SIGNAL_PROTOCOL, serializeSignalBundle, parseSignalBundle, parseIceCandidate, extractIceCandidates } from "defuss-webrtc/webrtc";
import { createCrdtDocument, crdt, canonicalSchema } from "defuss-webrtc/crdt";

// id + json helpers from the root entry point
assert.match(randomId(), /^[0-9a-f-]{36}$/);
assertJsonValue({ ok: [1, "two", null] });
assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));

// manual signaling: bundle round-trip
const bundle = {
  protocol: SIGNAL_PROTOCOL,
  version: 1,
  kind: "offer",
  peerId: "alice",
  sessionId: "s1",
  createdAt: new Date().toISOString(),
  description: { type: "offer", sdp: "v=0" },
  candidates: [],
  publicEndpoints: [],
};
const decoded = parseSignalBundle(serializeSignalBundle(bundle));
assert.equal(decoded.kind, "offer");
assert.equal(decoded.peerId, "alice");
assert.ok(SIGNAL_PROTOCOL.startsWith("defuss-webrtc/"));

// ICE candidate parsing
const candidate = parseIceCandidate("candidate:2 1 udp 1686052607 203.0.113.10 62000 typ srflx raddr 192.168.1.10 rport 51234 generation 0");
assert.deepEqual({ type: candidate.type, address: candidate.address, port: candidate.port }, { type: "srflx", address: "203.0.113.10", port: 62000 });
assert.equal(extractIceCandidates("v=0\\na=candidate:1 1 udp 2122260223 192.168.1.10 51234 typ host generation 0").length, 1);

// CRDT document: schema, local ops, state
const schema = crdt.schema({ title: crdt.register("draft"), count: crdt.counter() });
const doc = createCrdtDocument({ id: "doc-1", schema });
doc.set(["title"], "hello");
doc.increment(["count"], 2);
assert.equal(doc.state.title, "hello");
assert.equal(doc.state.count, 2);
assert.ok(canonicalSchema(schema).includes('"counter"'));

console.log("smoke ok");
`,
    );
    const output = execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, encoding: "utf8", timeout: EXEC_TIMEOUT });
    assert.match(output, /smoke ok/);
  });

  test("TypeScript types resolve for every entry point", () => {
    writeFileSync(
      join(consumer, "check.ts"),
      `import { randomId, type JsonValue } from "defuss-webrtc";
import { parseSignalBundle, DEFAULT_ICE_SERVERS, type SignalBundle } from "defuss-webrtc/webrtc";
import { createCrdtDocument, crdt, type InferSchema, type CrdtDocument } from "defuss-webrtc/crdt";

const id: string = randomId();
const value: JsonValue = { id };
const servers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS;
const bundle: SignalBundle = parseSignalBundle("{}");
void value; void servers; void bundle;

const schema = crdt.schema({ title: crdt.register("draft"), count: crdt.counter() });
type State = InferSchema<typeof schema>;
const doc: CrdtDocument<typeof schema> = createCrdtDocument({ id: "doc-1", schema });
const state: State = doc.state;
const title: string = state.title;
const count: number = state.count;
void title; void count;
`,
    );
    // Uses the repo's own tsc; resolution happens from the consumer's node_modules.
    execFileSync(
      TSC,
      ["--noEmit", "--strict", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--lib", "es2022,dom,dom.iterable", "check.ts"],
      { cwd: consumer, encoding: "utf8", timeout: EXEC_TIMEOUT, stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});
