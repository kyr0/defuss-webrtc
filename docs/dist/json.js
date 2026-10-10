export function assertJsonValue(value, label = "value") {
    const seen = new Set();
    const visit = (input, path) => {
        if (input === null || typeof input === "string" || typeof input === "boolean")
            return;
        if (typeof input === "number") {
            if (!Number.isFinite(input))
                throw new TypeError(`${path} must contain only finite numbers`);
            return;
        }
        if (typeof input !== "object") {
            throw new TypeError(`${path} must be JSON-serializable`);
        }
        if (seen.has(input))
            throw new TypeError(`${path} must not contain cycles`);
        seen.add(input);
        if (Array.isArray(input)) {
            for (let i = 0; i < input.length; i++)
                visit(input[i], `${path}[${i}]`);
        }
        else {
            const proto = Object.getPrototypeOf(input);
            if (proto !== Object.prototype && proto !== null) {
                throw new TypeError(`${path} must contain only plain objects and arrays`);
            }
            for (const [key, child] of Object.entries(input))
                visit(child, `${path}.${key}`);
        }
        seen.delete(input);
    };
    visit(value, label);
}
export function cloneJson(value) {
    if (typeof structuredClone === "function")
        return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
export function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
export function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
}
//# sourceMappingURL=json.js.map