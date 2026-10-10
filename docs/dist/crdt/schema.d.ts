import { type JsonValue } from "../json.js";
export interface RegisterSchema<T extends JsonValue = JsonValue> {
    readonly kind: "register";
    readonly initial: T;
}
export interface CounterSchema {
    readonly kind: "counter";
    readonly initial: number;
}
export interface SetSchema<T extends JsonValue = JsonValue> {
    readonly kind: "set";
    readonly initial: readonly T[];
}
export interface ObjectSchema<F extends Record<string, SchemaNode> = Record<string, SchemaNode>> {
    readonly kind: "object";
    readonly fields: F;
}
export interface MapSchema<V extends SchemaNode = SchemaNode> {
    readonly kind: "map";
    readonly value: V;
}
export interface ListSchema<T extends JsonValue = JsonValue> {
    readonly kind: "list";
    readonly initial: readonly T[];
}
export type SchemaNode = RegisterSchema | CounterSchema | SetSchema | ObjectSchema | MapSchema | ListSchema;
type InferDepth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
type PrevDepth = {
    0: 0;
    1: 0;
    2: 1;
    3: 2;
    4: 3;
    5: 4;
    6: 5;
    7: 6;
    8: 7;
    9: 8;
    10: 9;
    11: 10;
    12: 11;
};
export type InferSchema<S extends SchemaNode, D extends InferDepth = 12> = D extends 0 ? unknown : S extends RegisterSchema<infer T> ? T : S extends CounterSchema ? number : S extends SetSchema<infer T> ? T[] : S extends ObjectSchema<infer F> ? {
    [K in keyof F]: InferSchema<F[K], PrevDepth[D]>;
} : S extends MapSchema<infer V> ? Record<string, InferSchema<V, PrevDepth[D]>> : S extends ListSchema<infer T> ? T[] : never;
export interface ResolvedSchemaPath {
    node: SchemaNode;
    mapAncestors: Array<{
        path: string[];
        key: string;
        valuePath: string[];
    }>;
}
export declare function register<T extends JsonValue>(initial: T): RegisterSchema<T>;
export declare function counter(initial?: number): CounterSchema;
export declare function orSet<T extends JsonValue>(initial?: readonly T[]): SetSchema<T>;
export declare function object<const F extends Record<string, SchemaNode>>(fields: F): ObjectSchema<F>;
export declare function map<V extends SchemaNode>(value: V): MapSchema<V>;
export declare function list<T extends JsonValue>(initial?: readonly T[]): ListSchema<T>;
export declare function defineSchema<const F extends Record<string, SchemaNode>>(fields: F): ObjectSchema<F>;
export declare const crdt: {
    register: typeof register;
    counter: typeof counter;
    set: typeof orSet;
    object: typeof object;
    map: typeof map;
    list: typeof list;
    schema: typeof defineSchema;
};
export declare function canonicalSchema(schema: SchemaNode): string;
export declare function schemaFingerprint(schema: SchemaNode): string;
export declare function resolveSchemaPath(schema: SchemaNode, path: readonly string[]): ResolvedSchemaPath;
export {};
//# sourceMappingURL=schema.d.ts.map