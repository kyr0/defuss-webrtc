import { assertJsonValue, cloneJson, stableStringify } from "../json.js";
function freeze(value) {
    return Object.freeze(value);
}
export function register(initial) {
    assertJsonValue(initial, "register initial value");
    return freeze({ kind: "register", initial: cloneJson(initial) });
}
export function counter(initial = 0) {
    if (!Number.isFinite(initial))
        throw new TypeError("counter initial value must be finite");
    return freeze({ kind: "counter", initial });
}
export function orSet(initial = []) {
    const unique = new Map();
    for (const item of initial) {
        assertJsonValue(item, "set initial value");
        unique.set(stableStringify(item), cloneJson(item));
    }
    return freeze({ kind: "set", initial: freeze([...unique.values()]) });
}
export function object(fields) {
    for (const [key, value] of Object.entries(fields)) {
        if (!key)
            throw new TypeError("object schema field names must not be empty");
        if (!value || typeof value !== "object" || typeof value.kind !== "string") {
            throw new TypeError(`Invalid schema node at field ${key}`);
        }
    }
    return freeze({ kind: "object", fields: freeze({ ...fields }) });
}
export function map(value) {
    return freeze({ kind: "map", value });
}
export function list(initial = []) {
    const copy = initial.map((item, index) => {
        assertJsonValue(item, `list initial value ${index}`);
        return cloneJson(item);
    });
    return freeze({ kind: "list", initial: freeze(copy) });
}
export function defineSchema(fields) {
    return object(fields);
}
export const crdt = freeze({ register, counter, set: orSet, object, map, list, schema: defineSchema });
function schemaDescriptor(node) {
    switch (node.kind) {
        case "register": return { kind: "register", initial: cloneJson(node.initial) };
        case "counter": return { kind: "counter", initial: node.initial };
        case "set": return { kind: "set", initial: node.initial.map(cloneJson) };
        case "list": return { kind: "list", initial: node.initial.map(cloneJson) };
        case "map": return { kind: "map", value: schemaDescriptor(node.value) };
        case "object": {
            const fields = {};
            for (const key of Object.keys(node.fields).sort())
                fields[key] = schemaDescriptor(node.fields[key]);
            return { kind: "object", fields };
        }
    }
}
export function canonicalSchema(schema) {
    return stableStringify(schemaDescriptor(schema));
}
export function schemaFingerprint(schema) {
    const input = canonicalSchema(schema);
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of new TextEncoder().encode(input)) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * prime);
    }
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
export function resolveSchemaPath(schema, path) {
    let node = schema;
    const mapAncestors = [];
    const consumed = [];
    for (const segment of path) {
        if (!segment)
            throw new TypeError("CRDT paths must not contain empty segments");
        if (node.kind === "object") {
            const next = node.fields[segment];
            if (!next)
                throw new TypeError(`Unknown schema path: ${[...consumed, segment].join(".")}`);
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
//# sourceMappingURL=schema.js.map