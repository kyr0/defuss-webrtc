import { type JsonValue } from "../json.js";
import { type InferSchema, type SchemaNode } from "./schema.js";
import { type CrdtOp, type CrdtPath } from "./ops.js";
import { type VersionVector } from "./wire.js";
export interface CrdtDocumentOptions<S extends SchemaNode> {
    id: string;
    schema: S;
    actorId?: string;
    maxMessageBytes?: number;
    maxBufferedAmount?: number;
}
export interface CrdtChange<S extends SchemaNode> {
    origin: "local" | "remote" | "import";
    ops: readonly CrdtOp[];
    state: InferSchema<S>;
}
export interface CrdtError {
    code: string;
    message: string;
    cause?: unknown;
}
export interface SerializedCrdtDocument {
    protocol: "defuss-crdt/snapshot/1";
    docId: string;
    schema: string;
    schemaFingerprint: string;
    ops: CrdtOp[];
}
export declare class CrdtDocument<S extends SchemaNode> {
    #private;
    readonly id: string;
    readonly actorId: string;
    readonly schema: S;
    readonly schemaCanonical: string;
    readonly schemaFingerprint: string;
    constructor(options: CrdtDocumentOptions<S>);
    get state(): InferSchema<S>;
    get operationCount(): number;
    get versionVector(): VersionVector;
    get(path?: CrdtPath): unknown;
    subscribe(listener: (change: CrdtChange<S>) => void): () => void;
    onError(listener: (error: CrdtError) => void): () => void;
    batch(fn: (doc: this) => void): void;
    set(path: CrdtPath, value: JsonValue): void;
    increment(path: CrdtPath, delta?: number): void;
    setAdd(path: CrdtPath, value: JsonValue): void;
    setDelete(path: CrdtPath, value: JsonValue): boolean;
    mapEnsure(path: CrdtPath, key: string): void;
    mapDelete(path: CrdtPath, key: string): boolean;
    listInsert(path: CrdtPath, index: number, value: JsonValue): string;
    listSet(path: CrdtPath, index: number, value: JsonValue): void;
    listDelete(path: CrdtPath, index: number): boolean;
    export(): SerializedCrdtDocument;
    merge(input: SerializedCrdtDocument | string): number;
    attach(channel: RTCDataChannel): () => void;
    close(): void;
}
export declare function createCrdtDocument<S extends SchemaNode>(options: CrdtDocumentOptions<S>): CrdtDocument<S>;
//# sourceMappingURL=document.d.ts.map