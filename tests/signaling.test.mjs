import test from "node:test";
import assert from "node:assert/strict";
import {
  extractIceCandidates,
  getServerReflexiveEndpoints,
  parseIceCandidate,
  parseSignalBundle,
  serializeSignalBundle,
  SIGNAL_PROTOCOL,
} from "../dist/webrtc/index.js";

const sdp = [
  "v=0",
  "a=candidate:1 1 udp 2122260223 192.168.1.10 51234 typ host generation 0",
  "a=candidate:2 1 udp 1686052607 203.0.113.10 62000 typ srflx raddr 192.168.1.10 rport 51234 generation 0",
  "a=candidate:3 1 udp 41885439 198.51.100.20 53000 typ relay raddr 203.0.113.10 rport 62000 generation 0",
  "",
].join("\r\n");

test("ICE candidate parser exposes server-reflexive public endpoint metadata", () => {
  const parsed = parseIceCandidate("candidate:2 1 udp 1686052607 203.0.113.10 62000 typ srflx raddr 192.168.1.10 rport 51234 generation 0");
  assert.equal(parsed.address, "203.0.113.10");
  assert.equal(parsed.port, 62000);
  assert.equal(parsed.type, "srflx");
  assert.equal(parsed.relatedAddress, "192.168.1.10");
  assert.equal(parsed.relatedPort, 51234);

  assert.equal(extractIceCandidates(sdp).length, 3);
  assert.deepEqual(getServerReflexiveEndpoints(sdp), [
    { address: "203.0.113.10", port: 62000, protocol: "udp" },
  ]);
});

test("manual signaling JSON round-trips and validates kind/SDP", () => {
  const bundle = {
    protocol: SIGNAL_PROTOCOL,
    version: 1,
    kind: "offer",
    sessionId: "session-1",
    peerId: "peer-a",
    createdAt: "2026-09-27T16:00:00.000Z",
    description: { type: "offer", sdp },
    candidates: extractIceCandidates(sdp),
    publicEndpoints: getServerReflexiveEndpoints(sdp),
    metadata: { schema: "demo" },
  };
  const decoded = parseSignalBundle(serializeSignalBundle(bundle));
  assert.deepEqual(decoded, bundle);
});
