export function opId(actor, seq) {
    return `${actor}#${seq}`;
}
export function compareOp(a, b) {
    return a.clock - b.clock || a.actor.localeCompare(b.actor) || a.seq - b.seq;
}
export function samePath(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
export function isUnderPath(candidate, parent) {
    if (candidate.length < parent.length)
        return false;
    for (let i = 0; i < parent.length; i++)
        if (candidate[i] !== parent[i])
            return false;
    return true;
}
//# sourceMappingURL=ops.js.map