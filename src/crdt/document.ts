import { assertJsonValue, cloneJson, stableStringify, utf8Bytes, type JsonValue } from "../json.js";
import { randomId } from "../id.js";
import { canonicalSchema, resolveSchemaPath, schemaFingerprint, type InferSchema, type ListSchema, type MapSchema, type SchemaNode, type SetSchema } from "./schema.js";
import { compareOp, opId, samePath, type CrdtOp, type CrdtPath, type ListInsertOp, type OpBase, type SetAddOp } from "./ops.js";
import { CRDT_PROTOCOL, type HelloMessage, type OpsMessage, type VersionVector, type WireMessage } from "./wire.js";

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

interface ListEntry {
  id: string;
  value: JsonValue;
}

interface InternalListNode {
  id: string;
  after: string | null;
  value: JsonValue;
  order: Pick<OpBase, "clock" | "actor" | "seq">;
}

type LocalOpInput = CrdtOp extends infer O ? O extends CrdtOp ? Omit<O, keyof OpBase> & Pick<OpBase, "path"> : never : never;

interface ChannelBinding {
  channel: RTCDataChannel;
  queue: string[];
  rejected: boolean;
  closed: boolean;
  send(message: WireMessage): void;
  sendOps(ops: readonly CrdtOp[]): void;
  detach(): void;
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function assertPath(path: CrdtPath): string[] {
  if (!Array.isArray(path) || path.length > 64) throw new TypeError("CRDT path must be an array with at most 64 segments");
  const copy = path.map((segment) => {
    if (typeof segment !== "string" || !segment || segment.length > 1024) throw new TypeError("CRDT path segments must be non-empty strings <= 1024 chars");
    return segment;
  });
  return copy;
}

function compareListSibling(a: InternalListNode, b: InternalListNode): number {
  return -compareOp(a.order, b.order);
}

function latestOp<T extends CrdtOp>(ops: readonly T[]): T | undefined {
  let latest: T | undefined;
  for (const op of ops) if (!latest || compareOp(op, latest) > 0) latest = op;
  return latest;
}

function isFinitePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export class CrdtDocument<S extends SchemaNode> {
  readonly id: string;
  readonly actorId: string;
  readonly schema: S;
  readonly schemaCanonical: string;
  readonly schemaFingerprint: string;

  #ops = new Map<string, CrdtOp>();
  #byPath = new Map<string, Set<string>>();
  #actorSeqs = new Map<string, Set<number>>();
  #frontier = new Map<string, number>();
  #clock = 0;
  #stateCache: InferSchema<S> | undefined;
  #localSeq = 0;
  #listeners = new Set<(change: CrdtChange<S>) => void>();
  #errorListeners = new Set<(error: CrdtError) => void>();
  #bindings = new Set<ChannelBinding>();
  #batchDepth = 0;
  #batchedLocalOps: CrdtOp[] = [];
  #maxMessageBytes: number;
  #maxBufferedAmount: number;

  constructor(options: CrdtDocumentOptions<S>) {
    if (!options.id || typeof options.id !== "string") throw new TypeError("CRDT document id must be a non-empty string");
    this.id = options.id;
    this.schema = options.schema;
    this.actorId = options.actorId ?? randomId();
    if (!this.actorId || this.actorId.length > 256) throw new TypeError("actorId must be a non-empty string <= 256 chars");
    this.schemaCanonical = canonicalSchema(options.schema);
    this.schemaFingerprint = schemaFingerprint(options.schema);
    this.#maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
    this.#maxBufferedAmount = options.maxBufferedAmount ?? 512 * 1024;
    if (this.#maxMessageBytes < 1024) throw new RangeError("maxMessageBytes must be >= 1024");
    if (this.#maxBufferedAmount < this.#maxMessageBytes) throw new RangeError("maxBufferedAmount must be >= maxMessageBytes");
  }

  get state(): InferSchema<S> {
    // Materializing replays every op at every path, so the result is cached until
    // the op-set changes. Callers still get a fresh copy each time (the state is
    // small; the history behind it may not be), so they cannot mutate the cache.
    this.#stateCache ??= this.#materializeNode(this.schema, [], 0) as InferSchema<S>;
    return structuredClone(this.#stateCache);
  }

  get operationCount(): number {
    return this.#ops.size;
  }

  get versionVector(): VersionVector {
    return Object.fromEntries([...this.#frontier.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  get(path: CrdtPath = []): unknown {
    const clean = assertPath(path);
    const resolved = resolveSchemaPath(this.schema, clean);
    const barrier = this.#activeBarrier(resolved.mapAncestors);
    if (barrier === null) return undefined;
    return this.#materializeNode(resolved.node, clean, barrier);
  }

  subscribe(listener: (change: CrdtChange<S>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onError(listener: (error: CrdtError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  batch(fn: (doc: this) => void): void {
    this.#batchDepth++;
    try {
      fn(this);
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0 && this.#batchedLocalOps.length) {
        const ops = this.#batchedLocalOps.splice(0);
        this.#broadcastOps(ops);
        this.#notify("local", ops);
      }
    }
  }

  set(path: CrdtPath, value: JsonValue): void {
    const clean = assertPath(path);
    assertJsonValue(value);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "register") throw new TypeError(`set() requires register schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    this.#emitLocal({ kind: "reg:set", path: clean, value: cloneJson(value) });
  }

  increment(path: CrdtPath, delta = 1): void {
    if (!Number.isFinite(delta)) throw new TypeError("counter delta must be finite");
    if (delta === 0) return;
    const clean = assertPath(path);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "counter") throw new TypeError(`increment() requires counter schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    this.#emitLocal({ kind: "counter:add", path: clean, delta });
  }

  setAdd(path: CrdtPath, value: JsonValue): void {
    const clean = assertPath(path);
    assertJsonValue(value);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "set") throw new TypeError(`setAdd() requires set schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const valueKey = stableStringify(value);
    this.#emitLocal({ kind: "set:add", path: clean, value: cloneJson(value), valueKey });
  }

  setDelete(path: CrdtPath, value: JsonValue): boolean {
    const clean = assertPath(path);
    assertJsonValue(value);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "set") throw new TypeError(`setDelete() requires set schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const barrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const valueKey = stableStringify(value);
    const removed = this.#liveSetTags(resolved.node, clean, barrier, valueKey);
    if (!removed.length) return false;
    this.#emitLocal({ kind: "set:remove", path: clean, valueKey, removed });
    return true;
  }

  mapEnsure(path: CrdtPath, key: string): void {
    if (!key) throw new TypeError("map key must be non-empty");
    const clean = assertPath(path);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "map") throw new TypeError(`mapEnsure() requires map schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const parentBarrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const lifecycle = this.#latestMapLifecycle(clean, key, parentBarrier);
    if (!lifecycle || lifecycle.kind === "map:delete") this.#emitLocal({ kind: "map:put", path: clean, key });
  }

  mapDelete(path: CrdtPath, key: string): boolean {
    if (!key) throw new TypeError("map key must be non-empty");
    const clean = assertPath(path);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "map") throw new TypeError(`mapDelete() requires map schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const parentBarrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const lifecycle = this.#latestMapLifecycle(clean, key, parentBarrier);
    if (!lifecycle || lifecycle.kind !== "map:put") return false;
    this.#emitLocal({ kind: "map:delete", path: clean, key });
    return true;
  }

  listInsert(path: CrdtPath, index: number, value: JsonValue): string {
    const clean = assertPath(path);
    assertJsonValue(value);
    if (!Number.isInteger(index) || index < 0) throw new RangeError("list index must be a non-negative integer");
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "list") throw new TypeError(`listInsert() requires list schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const barrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const entries = this.#materializeListEntries(resolved.node, clean, barrier);
    if (index > entries.length) throw new RangeError(`list index ${index} exceeds length ${entries.length}`);
    const after = index === 0 ? null : entries[index - 1]!.id;
    const op = this.#emitLocal({ kind: "list:insert", path: clean, after, value: cloneJson(value), elemId: "" });
    (op as { elemId: string }).elemId = op.id;
    return op.id;
  }

  listSet(path: CrdtPath, index: number, value: JsonValue): void {
    const clean = assertPath(path);
    assertJsonValue(value);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "list") throw new TypeError(`listSet() requires list schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const barrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const entries = this.#materializeListEntries(resolved.node, clean, barrier);
    const entry = entries[index];
    if (!entry || !Number.isInteger(index) || index < 0) throw new RangeError(`Invalid list index ${index}`);
    this.#emitLocal({ kind: "list:set", path: clean, elemId: entry.id, value: cloneJson(value) });
  }

  listDelete(path: CrdtPath, index: number): boolean {
    const clean = assertPath(path);
    const resolved = resolveSchemaPath(this.schema, clean);
    if (resolved.node.kind !== "list") throw new TypeError(`listDelete() requires list schema, got ${resolved.node.kind}`);
    this.#ensureMapAncestors(resolved.mapAncestors);
    const barrier = this.#activeBarrier(resolved.mapAncestors) ?? 0;
    const entries = this.#materializeListEntries(resolved.node, clean, barrier);
    const entry = entries[index];
    if (!entry || !Number.isInteger(index) || index < 0) return false;
    this.#emitLocal({ kind: "list:remove", path: clean, elemId: entry.id });
    return true;
  }

  export(): SerializedCrdtDocument {
    return {
      protocol: "defuss-crdt/snapshot/1",
      docId: this.id,
      schema: this.schemaCanonical,
      schemaFingerprint: this.schemaFingerprint,
      ops: [...this.#ops.values()].sort(compareOp).map((op) => structuredClone(op)),
    };
  }

  merge(input: SerializedCrdtDocument | string): number {
    const snapshot = typeof input === "string" ? JSON.parse(input) as SerializedCrdtDocument : input;
    if (!snapshot || snapshot.protocol !== "defuss-crdt/snapshot/1") throw new TypeError("Unsupported CRDT snapshot");
    if (snapshot.docId !== this.id) throw new Error(`CRDT snapshot docId mismatch: expected ${this.id}, got ${snapshot.docId}`);
    if (snapshot.schema !== this.schemaCanonical) throw new Error("CRDT snapshot schema mismatch");
    if (!Array.isArray(snapshot.ops)) throw new TypeError("CRDT snapshot ops must be an array");
    const added = this.#applyOps(snapshot.ops, "import");
    if (added.length) {
      this.#broadcastOps(added);
      this.#notify("import", added);
    }
    return added.length;
  }

  attach(channel: RTCDataChannel): () => void {
    if (channel.ordered !== true || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      throw new Error("CRDT synchronization requires a reliable ordered RTCDataChannel");
    }

    const queue: string[] = [];
    const binding = {} as ChannelBinding;
    const flush = (): void => {
      if (binding.closed || binding.rejected || channel.readyState !== "open") return;
      while (queue.length && channel.bufferedAmount < this.#maxBufferedAmount) channel.send(queue.shift()!);
    };
    const enqueue = (serialized: string): void => {
      if (utf8Bytes(serialized) > this.#maxMessageBytes) throw new RangeError(`CRDT wire message exceeds maxMessageBytes=${this.#maxMessageBytes}`);
      queue.push(serialized);
      flush();
    };
    const send = (message: WireMessage): void => enqueue(JSON.stringify(message));
    const sendOps = (ops: readonly CrdtOp[]): void => {
      let chunk: CrdtOp[] = [];
      for (const op of ops) {
        const trial = [...chunk, op];
        const message: OpsMessage = { protocol: CRDT_PROTOCOL, kind: "ops", docId: this.id, ops: trial };
        if (utf8Bytes(JSON.stringify(message)) <= this.#maxMessageBytes) {
          chunk = trial;
          continue;
        }
        if (!chunk.length) throw new RangeError(`Single CRDT operation ${op.id} exceeds maxMessageBytes=${this.#maxMessageBytes}`);
        send({ protocol: CRDT_PROTOCOL, kind: "ops", docId: this.id, ops: chunk });
        chunk = [op];
      }
      if (chunk.length) send({ protocol: CRDT_PROTOCOL, kind: "ops", docId: this.id, ops: chunk });
    };
    const onOpen = (): void => {
      channel.bufferedAmountLowThreshold = Math.floor(this.#maxBufferedAmount / 2);
      this.#sendHello(binding, false);
      flush();
    };
    const onBufferedLow = (): void => flush();
    const onMessage = (event: MessageEvent): void => this.#onMessage(binding, event.data);
    const onClose = (): void => { binding.closed = true; this.#bindings.delete(binding); };

    binding.channel = channel;
    binding.queue = queue;
    binding.rejected = false;
    binding.closed = false;
    binding.send = send;
    binding.sendOps = sendOps;
    binding.detach = () => {
      if (binding.closed) return;
      binding.closed = true;
      this.#bindings.delete(binding);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("bufferedamountlow", onBufferedLow);
      channel.removeEventListener("close", onClose);
    };

    channel.addEventListener("open", onOpen);
    channel.addEventListener("message", onMessage);
    channel.addEventListener("bufferedamountlow", onBufferedLow);
    channel.addEventListener("close", onClose);
    this.#bindings.add(binding);
    if (channel.readyState === "open") queueMicrotask(onOpen);
    return binding.detach;
  }

  close(): void {
    for (const binding of [...this.#bindings]) binding.detach();
  }

  #sendHello(binding: ChannelBinding, reply: boolean): void {
    const message: HelloMessage = {
      protocol: CRDT_PROTOCOL,
      kind: "hello",
      docId: this.id,
      actorId: this.actorId,
      schema: this.schemaCanonical,
      schemaFingerprint: this.schemaFingerprint,
      vector: this.versionVector,
      reply,
    };
    binding.send(message);
  }

  #onMessage(binding: ChannelBinding, data: unknown): void {
    if (binding.rejected || binding.closed) return;
    if (typeof data !== "string") {
      this.#reportError({ code: "WIRE_BINARY_UNSUPPORTED", message: "defuss-crdt expects UTF-8 JSON string messages" });
      return;
    }
    if (utf8Bytes(data) > this.#maxMessageBytes) {
      this.#rejectBinding(binding, "WIRE_TOO_LARGE", `Incoming CRDT message exceeds ${this.#maxMessageBytes} bytes`);
      return;
    }

    let message: WireMessage;
    try {
      message = JSON.parse(data) as WireMessage;
    } catch (cause) {
      this.#rejectBinding(binding, "WIRE_INVALID_JSON", "Incoming CRDT message is not valid JSON", cause);
      return;
    }
    if (!message || message.protocol !== CRDT_PROTOCOL || message.docId !== this.id) {
      this.#rejectBinding(binding, "WIRE_PROTOCOL_MISMATCH", "Incoming CRDT message targets another protocol/document");
      return;
    }

    if (message.kind === "hello") {
      if (message.schema !== this.schemaCanonical) {
        this.#rejectBinding(binding, "SCHEMA_MISMATCH", `CRDT schema mismatch (${message.schemaFingerprint} != ${this.schemaFingerprint})`);
        return;
      }
      if (!message.reply) this.#sendHello(binding, true);
      this.#sendMissing(binding, message.vector);
      return;
    }

    if (message.kind === "error") {
      this.#reportError({ code: `REMOTE_${message.code}`, message: message.message });
      return;
    }

    if (message.kind === "ops") {
      if (!Array.isArray(message.ops)) {
        this.#rejectBinding(binding, "OPS_INVALID", "Incoming ops payload is not an array");
        return;
      }
      try {
        const added = this.#applyOps(message.ops, "remote");
        if (!added.length) return;
        for (const other of this.#bindings) if (other !== binding && !other.rejected && !other.closed) other.sendOps(added);
        this.#notify("remote", added);
      } catch (cause) {
        this.#rejectBinding(binding, "OPS_INVALID", cause instanceof Error ? cause.message : "Invalid incoming CRDT operation", cause);
      }
    }
  }

  #rejectBinding(binding: ChannelBinding, code: string, message: string, cause?: unknown): void {
    try {
      binding.send({ protocol: CRDT_PROTOCOL, kind: "error", docId: this.id, code, message });
    } catch {
      // The local error is still surfaced below.
    }
    binding.rejected = true;
    this.#reportError({ code, message, ...(cause === undefined ? {} : { cause }) });
  }

  #sendMissing(binding: ChannelBinding, remote: VersionVector): void {
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) throw new TypeError("Invalid remote version vector");
    const missing = [...this.#ops.values()]
      .filter((op) => op.seq > (Number.isSafeInteger(remote[op.actor]) ? remote[op.actor]! : 0))
      .sort(compareOp);
    if (missing.length) binding.sendOps(missing);
  }

  #broadcastOps(ops: readonly CrdtOp[]): void {
    if (!ops.length) return;
    for (const binding of this.#bindings) if (!binding.rejected && !binding.closed) binding.sendOps(ops);
  }

  #notify(origin: CrdtChange<S>["origin"], ops: readonly CrdtOp[]): void {
    // Without listeners nobody can observe the state: skip materializing it, so
    // writes stay cheap no matter how long the history is.
    if (!ops.length || !this.#listeners.size) return;
    const change: CrdtChange<S> = { origin, ops, state: this.state };
    for (const listener of this.#listeners) listener(change);
  }

  #reportError(error: CrdtError): void {
    for (const listener of this.#errorListeners) listener(error);
  }

  #emitLocal(partial: LocalOpInput): CrdtOp {
    const seq = ++this.#localSeq;
    const clock = ++this.#clock;
    const id = opId(this.actorId, seq);
    const op = { ...partial, id, actor: this.actorId, seq, clock } as CrdtOp;
    if (op.kind === "list:insert" && !op.elemId) op.elemId = id;
    this.#validateOp(op);
    const added = this.#applyOps([op], "local");
    if (added.length !== 1) throw new Error(`Local CRDT operation collision: ${id}`);
    if (this.#batchDepth) this.#batchedLocalOps.push(op);
    else {
      this.#broadcastOps([op]);
      this.#notify("local", [op]);
    }
    return op;
  }

  #applyOps(ops: readonly CrdtOp[], origin: CrdtChange<S>["origin"]): CrdtOp[] {
    const added: CrdtOp[] = [];
    for (const input of ops) {
      this.#validateOp(input);
      if (this.#ops.has(input.id)) continue;
      const op = structuredClone(input) as CrdtOp;
      this.#ops.set(op.id, op);
      const key = pathKey(op.path);
      let ids = this.#byPath.get(key);
      if (!ids) this.#byPath.set(key, ids = new Set());
      ids.add(op.id);
      let seqs = this.#actorSeqs.get(op.actor);
      if (!seqs) this.#actorSeqs.set(op.actor, seqs = new Set());
      seqs.add(op.seq);
      let frontier = this.#frontier.get(op.actor) ?? 0;
      while (seqs.has(frontier + 1)) frontier++;
      this.#frontier.set(op.actor, frontier);
      this.#clock = Math.max(this.#clock, op.clock);
      if (op.actor === this.actorId) this.#localSeq = Math.max(this.#localSeq, op.seq);
      added.push(op);
    }
    if (added.length) this.#stateCache = undefined;
    void origin;
    return added;
  }

  #validateOp(op: CrdtOp): void {
    if (!op || typeof op !== "object") throw new TypeError("CRDT operation must be an object");
    if (typeof op.actor !== "string" || !op.actor || op.actor.length > 256) throw new TypeError("Invalid CRDT actor");
    if (!isFinitePositiveInt(op.seq) || !isFinitePositiveInt(op.clock)) throw new TypeError("Invalid CRDT seq/clock");
    if (op.id !== opId(op.actor, op.seq)) throw new TypeError(`Invalid CRDT operation id ${op.id}`);
    const clean = assertPath(op.path);
    if (!samePath(clean, op.path)) throw new TypeError("Invalid CRDT path");

    if (op.kind === "map:put" || op.kind === "map:delete") {
      const resolved = resolveSchemaPath(this.schema, op.path);
      if (resolved.node.kind !== "map") throw new TypeError(`${op.kind} targets non-map schema`);
      if (typeof op.key !== "string" || !op.key) throw new TypeError(`${op.kind} requires non-empty key`);
      return;
    }

    const resolved = resolveSchemaPath(this.schema, op.path);
    switch (op.kind) {
      case "reg:set":
        if (resolved.node.kind !== "register") throw new TypeError("reg:set targets non-register schema");
        assertJsonValue(op.value, "register value");
        return;
      case "counter:add":
        if (resolved.node.kind !== "counter" || !Number.isFinite(op.delta)) throw new TypeError("Invalid counter:add operation");
        return;
      case "set:add":
        if (resolved.node.kind !== "set") throw new TypeError("set:add targets non-set schema");
        assertJsonValue(op.value, "set value");
        if (op.valueKey !== stableStringify(op.value)) throw new TypeError("set:add valueKey mismatch");
        return;
      case "set:remove":
        if (resolved.node.kind !== "set" || typeof op.valueKey !== "string" || !isStringArray(op.removed)) throw new TypeError("Invalid set:remove operation");
        return;
      case "list:insert":
        if (resolved.node.kind !== "list") throw new TypeError("list:insert targets non-list schema");
        assertJsonValue(op.value, "list value");
        if (op.elemId !== op.id || (op.after !== null && typeof op.after !== "string")) throw new TypeError("Invalid list:insert operation");
        return;
      case "list:set":
        if (resolved.node.kind !== "list" || typeof op.elemId !== "string") throw new TypeError("Invalid list:set operation");
        assertJsonValue(op.value, "list value");
        return;
      case "list:remove":
        if (resolved.node.kind !== "list" || typeof op.elemId !== "string") throw new TypeError("Invalid list:remove operation");
        return;
    }
  }

  #opsAt(path: readonly string[]): CrdtOp[] {
    const ids = this.#byPath.get(pathKey(path));
    if (!ids) return [];
    return [...ids].map((id) => this.#ops.get(id)!).filter(Boolean);
  }

  #ensureMapAncestors(ancestors: ReturnType<typeof resolveSchemaPath>["mapAncestors"]): void {
    let barrier = 0;
    for (const ancestor of ancestors) {
      const lifecycle = this.#latestMapLifecycle(ancestor.path, ancestor.key, barrier);
      if (!lifecycle || lifecycle.kind === "map:delete") {
        const op = this.#emitLocal({ kind: "map:put", path: ancestor.path, key: ancestor.key });
        barrier = op.clock;
      } else {
        barrier = Math.max(barrier, lifecycle.clock);
      }
    }
  }

  #activeBarrier(ancestors: ReturnType<typeof resolveSchemaPath>["mapAncestors"]): number | null {
    let barrier = 0;
    for (const ancestor of ancestors) {
      const lifecycle = this.#latestMapLifecycle(ancestor.path, ancestor.key, barrier);
      if (!lifecycle || lifecycle.kind !== "map:put") return null;
      barrier = Math.max(barrier, lifecycle.clock);
    }
    return barrier;
  }

  #latestMapLifecycle(path: readonly string[], key: string, barrier: number): Extract<CrdtOp, { kind: "map:put" | "map:delete" }> | undefined {
    return latestOp(this.#opsAt(path).filter((op): op is Extract<CrdtOp, { kind: "map:put" | "map:delete" }> =>
      (op.kind === "map:put" || op.kind === "map:delete") && op.key === key && op.clock > barrier,
    ));
  }

  #materializeNode(node: SchemaNode, path: string[], barrier: number): unknown {
    switch (node.kind) {
      case "register": {
        const op = latestOp(this.#opsAt(path).filter((item): item is Extract<CrdtOp, { kind: "reg:set" }> => item.kind === "reg:set" && item.clock > barrier));
        return cloneJson(op?.value ?? node.initial);
      }
      case "counter": {
        let value = node.initial;
        for (const op of this.#opsAt(path)) if (op.kind === "counter:add" && op.clock > barrier) value += op.delta;
        return value;
      }
      case "set": {
        const values = new Map<string, JsonValue>();
        const removed = new Set<string>();
        const adds: SetAddOp[] = [];
        for (const op of this.#opsAt(path)) {
          if (op.clock <= barrier) continue;
          if (op.kind === "set:add") adds.push(op);
          else if (op.kind === "set:remove") for (const id of op.removed) removed.add(id);
        }
        for (const initial of node.initial) {
          const key = stableStringify(initial);
          if (!removed.has(`@init:${key}`)) values.set(key, cloneJson(initial));
        }
        for (const op of adds.sort(compareOp)) if (!removed.has(op.id)) values.set(op.valueKey, cloneJson(op.value));
        return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
      }
      case "object": {
        const value: Record<string, unknown> = {};
        for (const key of Object.keys(node.fields)) value[key] = this.#materializeNode(node.fields[key]!, [...path, key], barrier);
        return value;
      }
      case "map": {
        const lifecycle = this.#opsAt(path).filter((op): op is Extract<CrdtOp, { kind: "map:put" | "map:delete" }> =>
          (op.kind === "map:put" || op.kind === "map:delete") && op.clock > barrier,
        );
        const latestByKey = new Map<string, Extract<CrdtOp, { kind: "map:put" | "map:delete" }>>();
        for (const op of lifecycle) {
          const current = latestByKey.get(op.key);
          if (!current || compareOp(op, current) > 0) latestByKey.set(op.key, op);
        }
        const value: Record<string, unknown> = {};
        for (const key of [...latestByKey.keys()].sort()) {
          const op = latestByKey.get(key)!;
          if (op.kind !== "map:put") continue;
          value[key] = this.#materializeNode(node.value, [...path, key], Math.max(barrier, op.clock));
        }
        return value;
      }
      case "list": return this.#materializeListEntries(node, path, barrier).map((entry) => cloneJson(entry.value));
    }
  }

  #liveSetTags(node: SetSchema, path: string[], barrier: number, valueKey: string): string[] {
    const removed = new Set<string>();
    const tags: string[] = [];
    for (const op of this.#opsAt(path)) {
      if (op.clock <= barrier) continue;
      if (op.kind === "set:remove") for (const id of op.removed) removed.add(id);
    }
    for (const initial of node.initial) {
      const key = stableStringify(initial);
      const id = `@init:${key}`;
      if (key === valueKey && !removed.has(id)) tags.push(id);
    }
    for (const op of this.#opsAt(path)) {
      if (op.kind === "set:add" && op.clock > barrier && op.valueKey === valueKey && !removed.has(op.id)) tags.push(op.id);
    }
    return tags.sort();
  }

  #materializeListEntries(node: ListSchema, path: string[], barrier: number): ListEntry[] {
    const nodes = new Map<string, InternalListNode>();
    let previous: string | null = null;
    for (let i = 0; i < node.initial.length; i++) {
      const id = `@init:${i}`;
      nodes.set(id, {
        id,
        after: previous,
        value: cloneJson(node.initial[i]!),
        order: { clock: -1, actor: "", seq: i + 1 },
      });
      previous = id;
    }

    const ops = this.#opsAt(path).filter((op) => op.clock > barrier);
    for (const op of ops) {
      if (op.kind !== "list:insert") continue;
      nodes.set(op.elemId, {
        id: op.elemId,
        after: op.after,
        value: cloneJson(op.value),
        order: op,
      });
    }

    const latestValue = new Map<string, Extract<CrdtOp, { kind: "list:set" }>>();
    const removed = new Set<string>();
    for (const op of ops) {
      if (op.kind === "list:set") {
        const current = latestValue.get(op.elemId);
        if (!current || compareOp(op, current) > 0) latestValue.set(op.elemId, op);
      } else if (op.kind === "list:remove") {
        removed.add(op.elemId);
      }
    }

    const children = new Map<string | null, InternalListNode[]>();
    for (const listNode of nodes.values()) {
      if (listNode.after !== null && !nodes.has(listNode.after)) continue;
      let bucket = children.get(listNode.after);
      if (!bucket) children.set(listNode.after, bucket = []);
      bucket.push(listNode);
    }
    for (const bucket of children.values()) bucket.sort(compareListSibling);

    const result: ListEntry[] = [];
    const visited = new Set<string>();
    const visit = (after: string | null): void => {
      for (const listNode of children.get(after) ?? []) {
        if (visited.has(listNode.id)) continue;
        visited.add(listNode.id);
        if (!removed.has(listNode.id)) {
          const update = latestValue.get(listNode.id);
          result.push({ id: listNode.id, value: cloneJson(update?.value ?? listNode.value) });
        }
        visit(listNode.id);
      }
    };
    visit(null);
    return result;
  }
}

export function createCrdtDocument<S extends SchemaNode>(options: CrdtDocumentOptions<S>): CrdtDocument<S> {
  return new CrdtDocument(options);
}
