import { randomId } from "../id.js";
import { extractIceCandidates, getServerReflexiveEndpoints } from "./candidates.js";
export const SIGNAL_PROTOCOL = "defuss-webrtc/manual-signal/1";
export const DEFAULT_ICE_SERVERS = Object.freeze([
    Object.freeze({ urls: "stun:stun.cloudflare.com:3478" }),
]);
function assertRecordOfStrings(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("metadata must be a string record");
    for (const [key, item] of Object.entries(value)) {
        if (typeof key !== "string" || typeof item !== "string")
            throw new TypeError("metadata must be a string record");
    }
}
export function parseSignalBundle(input) {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Invalid signaling bundle");
    const bundle = value;
    if (bundle.protocol !== SIGNAL_PROTOCOL || bundle.version !== 1)
        throw new TypeError("Unsupported signaling bundle protocol");
    if (bundle.kind !== "offer" && bundle.kind !== "answer")
        throw new TypeError("Invalid signaling bundle kind");
    if (typeof bundle.sessionId !== "string" || !bundle.sessionId)
        throw new TypeError("Invalid sessionId");
    if (typeof bundle.peerId !== "string" || !bundle.peerId)
        throw new TypeError("Invalid peerId");
    if (typeof bundle.createdAt !== "string")
        throw new TypeError("Invalid createdAt");
    if (!bundle.description || typeof bundle.description.sdp !== "string")
        throw new TypeError("Invalid session description");
    if (bundle.description.type !== bundle.kind)
        throw new TypeError("Description type does not match bundle kind");
    if (bundle.kind === "answer" && (typeof bundle.replyTo !== "string" || bundle.replyTo !== bundle.sessionId)) {
        throw new TypeError("Invalid answer replyTo");
    }
    assertRecordOfStrings(bundle.metadata);
    return bundle;
}
export function serializeSignalBundle(bundle, pretty = true) {
    return JSON.stringify(bundle, null, pretty ? 2 : 0);
}
export function signalFileName(bundle) {
    return `defuss-webrtc-${bundle.kind}-${bundle.peerId.slice(0, 8)}-${bundle.sessionId.slice(0, 8)}.json`;
}
export function downloadSignalBundle(bundle, filename = signalFileName(bundle)) {
    if (typeof document === "undefined" || typeof URL === "undefined") {
        throw new Error("downloadSignalBundle() requires a browser DOM");
    }
    const blob = new Blob([serializeSignalBundle(bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
export async function readSignalFile(file) {
    return parseSignalBundle(await file.text());
}
function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete")
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timeout;
        const cleanup = () => {
            pc.removeEventListener("icegatheringstatechange", onChange);
            if (timeout)
                clearTimeout(timeout);
        };
        const onChange = () => {
            if (pc.iceGatheringState !== "complete")
                return;
            cleanup();
            resolve();
        };
        pc.addEventListener("icegatheringstatechange", onChange);
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`ICE gathering did not complete within ${timeoutMs} ms`));
        }, timeoutMs);
    });
}
function createBundleBase(peerId, sessionId, description, metadata) {
    const sdp = description.sdp ?? "";
    return {
        protocol: SIGNAL_PROTOCOL,
        version: 1,
        sessionId,
        peerId,
        createdAt: new Date().toISOString(),
        description,
        candidates: extractIceCandidates(sdp),
        publicEndpoints: getServerReflexiveEndpoints(sdp),
        ...(metadata ? { metadata: { ...metadata } } : {}),
    };
}
export class ManualPeer {
    peerId;
    connection;
    channelLabel;
    #channel = null;
    #channelWaiters = new Set();
    #sessionId = null;
    #iceGatheringTimeoutMs;
    #channelOptions;
    constructor(options = {}) {
        if (typeof RTCPeerConnection === "undefined") {
            throw new Error("ManualPeer requires a WebRTC-capable browser/runtime");
        }
        this.peerId = options.peerId ?? randomId();
        this.channelLabel = options.channelLabel ?? "defuss";
        this.#iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 15_000;
        this.#channelOptions = { ordered: true, ...options.channelOptions };
        this.connection = new RTCPeerConnection({
            ...options.rtcConfiguration,
            iceServers: options.iceServers ?? [...DEFAULT_ICE_SERVERS],
        });
        this.connection.addEventListener("datachannel", (event) => this.#setChannel(event.channel));
    }
    get dataChannel() {
        return this.#channel;
    }
    async createOffer(options = {}) {
        assertRecordOfStrings(options.metadata);
        if (this.connection.signalingState !== "stable")
            throw new Error(`Cannot create offer while signalingState=${this.connection.signalingState}`);
        if (!this.#channel)
            this.#setChannel(this.connection.createDataChannel(this.channelLabel, this.#channelOptions));
        const sessionId = randomId();
        this.#sessionId = sessionId;
        await this.connection.setLocalDescription(await this.connection.createOffer());
        await waitForIceGatheringComplete(this.connection, this.#iceGatheringTimeoutMs);
        const description = this.connection.localDescription;
        if (!description || description.type !== "offer")
            throw new Error("Browser did not produce an offer description");
        return {
            ...createBundleBase(this.peerId, sessionId, { type: "offer", sdp: description.sdp }, options.metadata),
            kind: "offer",
            description: { type: "offer", sdp: description.sdp },
        };
    }
    async acceptOffer(input, options = {}) {
        assertRecordOfStrings(options.metadata);
        const bundle = parseSignalBundle(input);
        if (bundle.kind !== "offer")
            throw new TypeError("acceptOffer() requires an offer bundle");
        if (this.connection.signalingState !== "stable")
            throw new Error(`Cannot accept offer while signalingState=${this.connection.signalingState}`);
        this.#sessionId = bundle.sessionId;
        await this.connection.setRemoteDescription(bundle.description);
        await this.connection.setLocalDescription(await this.connection.createAnswer());
        await waitForIceGatheringComplete(this.connection, this.#iceGatheringTimeoutMs);
        const description = this.connection.localDescription;
        if (!description || description.type !== "answer")
            throw new Error("Browser did not produce an answer description");
        return {
            ...createBundleBase(this.peerId, bundle.sessionId, { type: "answer", sdp: description.sdp }, options.metadata),
            kind: "answer",
            replyTo: bundle.sessionId,
            description: { type: "answer", sdp: description.sdp },
        };
    }
    async acceptAnswer(input) {
        const bundle = parseSignalBundle(input);
        if (bundle.kind !== "answer")
            throw new TypeError("acceptAnswer() requires an answer bundle");
        if (!this.#sessionId || bundle.sessionId !== this.#sessionId)
            throw new Error("Answer belongs to a different signaling session");
        await this.connection.setRemoteDescription(bundle.description);
    }
    waitForDataChannel(timeoutMs = 20_000) {
        if (this.#channel)
            return Promise.resolve(this.#channel);
        return new Promise((resolve, reject) => {
            const onChannel = (channel) => {
                clearTimeout(timeout);
                this.#channelWaiters.delete(onChannel);
                resolve(channel);
            };
            const timeout = setTimeout(() => {
                this.#channelWaiters.delete(onChannel);
                reject(new Error(`Data channel was not negotiated within ${timeoutMs} ms`));
            }, timeoutMs);
            this.#channelWaiters.add(onChannel);
        });
    }
    async waitForOpen(timeoutMs = 20_000) {
        const channel = await this.waitForDataChannel(timeoutMs);
        if (channel.readyState === "open")
            return channel;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                channel.removeEventListener("open", onOpen);
                channel.removeEventListener("close", onClose);
                channel.removeEventListener("error", onError);
            };
            const onOpen = () => { cleanup(); resolve(channel); };
            const onClose = () => { cleanup(); reject(new Error("Data channel closed before opening")); };
            const onError = () => { cleanup(); reject(new Error("Data channel failed before opening")); };
            const timeout = setTimeout(() => { cleanup(); reject(new Error(`Data channel did not open within ${timeoutMs} ms`)); }, timeoutMs);
            channel.addEventListener("open", onOpen, { once: true });
            channel.addEventListener("close", onClose, { once: true });
            channel.addEventListener("error", onError, { once: true });
        });
    }
    close() {
        this.#channel?.close();
        this.connection.close();
    }
    #setChannel(channel) {
        if (this.#channel && this.#channel !== channel)
            throw new Error("ManualPeer supports one negotiated data channel per connection");
        this.#channel = channel;
        for (const waiter of this.#channelWaiters)
            waiter(channel);
        this.#channelWaiters.clear();
    }
}
//# sourceMappingURL=signaling.js.map