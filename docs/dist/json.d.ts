export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare function assertJsonValue(value: unknown, label?: string): asserts value is JsonValue;
export declare function cloneJson<T extends JsonValue>(value: T): T;
export declare function stableStringify(value: JsonValue): string;
export declare function utf8Bytes(value: string): number;
//# sourceMappingURL=json.d.ts.map