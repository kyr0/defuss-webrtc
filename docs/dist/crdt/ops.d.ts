import type { JsonValue } from "../json.js";
export type CrdtPath = readonly string[];
export interface OpBase {
    id: string;
    actor: string;
    seq: number;
    clock: number;
    path: string[];
}
export interface RegisterSetOp extends OpBase {
    kind: "reg:set";
    value: JsonValue;
}
export interface CounterAddOp extends OpBase {
    kind: "counter:add";
    delta: number;
}
export interface SetAddOp extends OpBase {
    kind: "set:add";
    value: JsonValue;
    valueKey: string;
}
export interface SetRemoveOp extends OpBase {
    kind: "set:remove";
    valueKey: string;
    removed: string[];
}
export interface MapPutOp extends OpBase {
    kind: "map:put";
    key: string;
}
export interface MapDeleteOp extends OpBase {
    kind: "map:delete";
    key: string;
}
export interface ListInsertOp extends OpBase {
    kind: "list:insert";
    elemId: string;
    after: string | null;
    value: JsonValue;
}
export interface ListSetOp extends OpBase {
    kind: "list:set";
    elemId: string;
    value: JsonValue;
}
export interface ListRemoveOp extends OpBase {
    kind: "list:remove";
    elemId: string;
}
export type CrdtOp = RegisterSetOp | CounterAddOp | SetAddOp | SetRemoveOp | MapPutOp | MapDeleteOp | ListInsertOp | ListSetOp | ListRemoveOp;
export declare function opId(actor: string, seq: number): string;
export declare function compareOp(a: Pick<OpBase, "clock" | "actor" | "seq">, b: Pick<OpBase, "clock" | "actor" | "seq">): number;
export declare function samePath(a: readonly string[], b: readonly string[]): boolean;
export declare function isUnderPath(candidate: readonly string[], parent: readonly string[]): boolean;
//# sourceMappingURL=ops.d.ts.map