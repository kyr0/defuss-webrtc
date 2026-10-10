import type { CrdtOp } from "./ops.js";
export declare const CRDT_PROTOCOL: "defuss-crdt/1";
export type VersionVector = Record<string, number>;
export interface HelloMessage {
    protocol: typeof CRDT_PROTOCOL;
    kind: "hello";
    docId: string;
    actorId: string;
    schema: string;
    schemaFingerprint: string;
    vector: VersionVector;
    reply: boolean;
}
export interface OpsMessage {
    protocol: typeof CRDT_PROTOCOL;
    kind: "ops";
    docId: string;
    ops: CrdtOp[];
}
export interface ErrorMessage {
    protocol: typeof CRDT_PROTOCOL;
    kind: "error";
    docId: string;
    code: string;
    message: string;
}
export type WireMessage = HelloMessage | OpsMessage | ErrorMessage;
//# sourceMappingURL=wire.d.ts.map