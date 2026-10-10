export type IceCandidateType = "host" | "srflx" | "prflx" | "relay" | string;
export interface IceCandidateSummary {
    foundation: string;
    component: number;
    protocol: string;
    priority: number;
    address: string;
    port: number;
    type: IceCandidateType;
    relatedAddress?: string;
    relatedPort?: number;
    tcpType?: string;
    raw: string;
}
export interface PublicEndpoint {
    address: string;
    port: number;
    protocol: string;
}
export declare function parseIceCandidate(candidate: string): IceCandidateSummary | null;
export declare function extractIceCandidates(sdp: string): IceCandidateSummary[];
export declare function getServerReflexiveEndpoints(input: string | {
    description: RTCSessionDescriptionInit;
}): PublicEndpoint[];
//# sourceMappingURL=candidates.d.ts.map