import { type IceCandidateSummary, type PublicEndpoint } from "./candidates.js";
export declare const SIGNAL_PROTOCOL: "defuss-webrtc/manual-signal/1";
export declare const DEFAULT_ICE_SERVERS: readonly RTCIceServer[];
export interface SignalBundleBase {
    protocol: typeof SIGNAL_PROTOCOL;
    version: 1;
    sessionId: string;
    peerId: string;
    createdAt: string;
    description: RTCSessionDescriptionInit;
    candidates: IceCandidateSummary[];
    publicEndpoints: PublicEndpoint[];
    metadata?: Record<string, string>;
}
export interface OfferSignalBundle extends SignalBundleBase {
    kind: "offer";
    description: RTCSessionDescriptionInit & {
        type: "offer";
    };
}
export interface AnswerSignalBundle extends SignalBundleBase {
    kind: "answer";
    replyTo: string;
    description: RTCSessionDescriptionInit & {
        type: "answer";
    };
}
export type SignalBundle = OfferSignalBundle | AnswerSignalBundle;
export interface ManualPeerOptions {
    peerId?: string;
    iceServers?: RTCIceServer[];
    rtcConfiguration?: Omit<RTCConfiguration, "iceServers">;
    iceGatheringTimeoutMs?: number;
    channelLabel?: string;
    channelOptions?: RTCDataChannelInit;
}
export interface CreateOfferOptions {
    metadata?: Record<string, string>;
}
export interface AcceptOfferOptions {
    metadata?: Record<string, string>;
}
export declare function parseSignalBundle(input: string | unknown): SignalBundle;
export declare function serializeSignalBundle(bundle: SignalBundle, pretty?: boolean): string;
export declare function signalFileName(bundle: SignalBundle): string;
export declare function downloadSignalBundle(bundle: SignalBundle, filename?: string): void;
export declare function readSignalFile(file: Blob): Promise<SignalBundle>;
export declare class ManualPeer {
    #private;
    readonly peerId: string;
    readonly connection: RTCPeerConnection;
    readonly channelLabel: string;
    constructor(options?: ManualPeerOptions);
    get dataChannel(): RTCDataChannel | null;
    createOffer(options?: CreateOfferOptions): Promise<OfferSignalBundle>;
    acceptOffer(input: OfferSignalBundle | string, options?: AcceptOfferOptions): Promise<AnswerSignalBundle>;
    acceptAnswer(input: AnswerSignalBundle | string): Promise<void>;
    waitForDataChannel(timeoutMs?: number): Promise<RTCDataChannel>;
    waitForOpen(timeoutMs?: number): Promise<RTCDataChannel>;
    close(): void;
}
//# sourceMappingURL=signaling.d.ts.map