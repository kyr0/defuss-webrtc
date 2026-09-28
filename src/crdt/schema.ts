import { assertJsonValue, cloneJson, stableStringify, type JsonValue } from "../json.js";

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
type PrevDepth = { 0: 0; 1: 0; 2: 1; 3: 2; 4: 3; 5: 4; 6: 5; 7: 6; 8: 7; 9: 8; 10: 9; 11: 10; 12: 11 };

export type InferSchema<S extends SchemaNode, D extends InferDepth = 12> =
  D extends 0 ? unknown
  : S extends RegisterSchema<infer T> ? T
  : S extends CounterSchema ? number
  : S extends SetSchema<infer T> ? T[]
  : S extends ObjectSchema<infer F> ? { [K in keyof F]: InferSchema<F[K], PrevDepth[D]> }
  : S extends MapSchema<infer V> ? Record<string, InferSchema<V, PrevDepth[D]>>
  : S extends ListSchema<infer T> ? T[]
  : never;

export interface ResolvedSchemaPath {
  node: SchemaNode;
  mapAncestors: Array<{ path: string[]; key: string; valuePath: string[] }>;
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}

export function register<T extends JsonValue>(initial: T): RegisterSchema<T> {
  assertJsonValue(initial, "register initial value");
  return freeze({ kind: "register", initial: cloneJson(initial) });
}

export function counter(initial = 0): CounterSchema {
  if (!Number.isFinite(initial)) throw new TypeError("counter initial value must be finite");
  return freeze({ kind: "counter", initial });
}

export function orSet<T extends JsonValue>(initial: readonly T[] = []): SetSchema<T> {
  const unique = new Map<string, T>();
  for (const item of initial) {
    assertJsonValue(item, "set initial value");
    unique.set(stableStringify(item), cloneJson(item));
  }
  return freeze({ kind: "set", initial: freeze([...unique.values()]) });
}

export function object<const F extends Record<string, SchemaNode>>(fields: F): ObjectSchema<F> {
  for (const [key, value] of Object.entries(fields)) {
    if (!key) throw new TypeError("object schema field names must not be empty");
    if (!value || typeof value !== "object" || typeof value.kind !== "string") {
      throw new TypeError(`Invalid schema node at field ${key}`);
    }
  }
  return freeze({ kind: "object", fields: freeze({ ...fields }) as F });
}

export function map<V extends SchemaNode>(value: V): MapSchema<V> {
  return freeze({ kind: "map", value });
}

export function list<T extends JsonValue>(initial: readonly T[] = []): ListSchema<T> {
  const copy = initial.map((item, index) => {
    assertJsonValue(item, `list initial value ${index}`);
    return cloneJson(item);
  });
  return freeze({ kind: "list", initial: freeze(copy) });
}

export function defineSchema<const F extends Record<string, SchemaNode>>(fields: F): ObjectSchema<F> {
  return object(fields);
}

export const crdt = freeze({ register, counter, set: orSet, object, map, list, schema: defineSchema });

function schemaDescriptor(node: SchemaNode): JsonValue {
  switch (node.kind) {
    case "register": return { kind: "register", initial: cloneJson(node.initial) };
    case "counter": return { kind: "counter", initial: node.initial };
    case "set": return { kind: "set", initial: node.initial.map(cloneJson) };
    case "list": return { kind: "list", initial: node.initial.map(cloneJson) };
    case "map": return { kind: "map", value: schemaDescriptor(node.value) };
    case "object": {
      const fields: Record<string, JsonValue> = {};
      for (const key of Object.keys(node.fields).sort()) fields[key] = schemaDescriptor(node.fields[key]!);
      return { kind: "object", fields };
    }
  }
}

export function canonicalSchema(schema: SchemaNode): string {
  return stableStringify(schemaDescriptor(schema));
}

export function schemaFingerprint(schema: SchemaNode): string {
  const input = canonicalSchema(schema);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export function resolveSchemaPath(schema: SchemaNode, path: readonly string[]): ResolvedSchemaPath {
  let node = schema;
  const mapAncestors: ResolvedSchemaPath["mapAncestors"] = [];
  const consumed: string[] = [];

  for (const segment of path) {
    if (!segment) throw new TypeError("CRDT paths must not contain empty segments");
    if (node.kind === "object") {
      const next = node.fields[segment];
      if (!next) throw new TypeError(`Unknown schema path: ${[...consumed, segment].join(".")}`);
      node = next;
      consumed.push(segment);
      continue;
    }
    if (node.kind === "map") {
      const mapPath = [...consumed];
      consumed.push(segment);
      mapAncestors.push({ path: mapPath, key: segment, valuePath: [...consumed] });
      node = node.value;
      continue;
    }
    throw new TypeError(`Schema node ${node.kind} cannot contain child path ${segment}`);
  }

  return { node, mapAncestors };
}
