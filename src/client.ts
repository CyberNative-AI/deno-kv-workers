// A Deno.Kv-shaped client for Worker code, backed by DenoKvObject.
// Unsupported Deno KV features (watch, queues) throw explicit errors instead of failing silently.
import { decodeKey, encodeKey, fromHex, type Key, type KeyPart, toHex } from "./keys.ts";
import type { CheckJSON, ListPage, MutationJSON } from "./object.ts";
import { selectorBounds } from "./selector.ts";
import { decodeBase64Url, encodeBase64Url } from "./vendor/base64url.ts";
import { keyToJSON, toValue, valueToJSON } from "./vendor/kv_json.ts";

export class KvU64 {
  readonly value: bigint;
  constructor(value: bigint) {
    if (typeof value !== "bigint") throw new TypeError("Value must be a bigint");
    if (value < 0n) throw new RangeError("Value must be a positive bigint");
    if (value > 0xffffffffffffffffn) throw new RangeError("Value must fit in a 64-bit unsigned integer");
    this.value = value;
  }
  valueOf() {
    return this.value;
  }
  toString() {
    return this.value.toString();
  }
}

// kv_json recognises `Deno.KvU64`; make the class available where no Deno global exists.
const g = globalThis as { Deno?: Record<string, unknown> };
g.Deno ??= {};
g.Deno.KvU64 ??= KvU64;

export type KvEntry<T> = { key: KeyPart[]; value: T; versionstamp: string };
export type KvEntryMaybe<T> = KvEntry<T> | { key: KeyPart[]; value: null; versionstamp: null };
export type KvListSelector = { prefix: Key } | { prefix: Key; start: Key } | { prefix: Key; end: Key } | { start: Key; end: Key };
export type KvListOptions = { limit?: number; cursor?: string; reverse?: boolean; batchSize?: number; consistency?: string };
type Commit = { ok: true; versionstamp: string } | { ok: false };

interface Backend {
  getMany(keys: unknown[]): Promise<{ value: unknown; versionstamp: string | null }[]>;
  list(sel: unknown, opts: { limit: number; reverse?: boolean; after?: string }): Promise<ListPage>;
  commit(checks: CheckJSON[], mutations: MutationJSON[]): Promise<Commit>;
}

const unsupported = (what: string, instead: string) =>
  new Error(`${what} is not supported on Cloudflare Workers by deno-kv-workers; ${instead}`);

function u64(n: bigint, op: string): KvU64 {
  if (typeof n !== "bigint") throw new TypeError(`Value must be a bigint: received ${typeof n} (${op})`);
  return new KvU64(n);
}

export class AtomicOperation {
  #checks: CheckJSON[] = [];
  #mutations: MutationJSON[] = [];
  constructor(private backend: Backend) {}

  check(...checks: { key: Key; versionstamp: string | null }[]): this {
    for (const c of checks) this.#checks.push({ key: keyToJSON(c.key as KeyPart[]), versionstamp: c.versionstamp });
    return this;
  }
  set(key: Key, value: unknown, options?: { expireIn?: number }): this {
    const expireIn = options?.expireIn;
    if (expireIn !== undefined && (!Number.isFinite(expireIn) || expireIn < 0)) {
      throw new TypeError("expireIn must be a non-negative number");
    }
    this.#mutations.push({ type: "set", key: keyToJSON(key as KeyPart[]), value: valueToJSON(value), expireIn });
    return this;
  }
  delete(key: Key): this {
    this.#mutations.push({ type: "delete", key: keyToJSON(key as KeyPart[]) });
    return this;
  }
  sum(key: Key, n: bigint): this {
    return this.#u64("sum", key, n);
  }
  min(key: Key, n: bigint): this {
    return this.#u64("min", key, n);
  }
  max(key: Key, n: bigint): this {
    return this.#u64("max", key, n);
  }
  #u64(type: "sum" | "min" | "max", key: Key, n: bigint): this {
    this.#mutations.push({ type, key: keyToJSON(key as KeyPart[]), value: valueToJSON(u64(n, type)) });
    return this;
  }
  mutate(...mutations: ({ type: string; key: Key; value?: unknown; expireIn?: number })[]): this {
    for (const m of mutations) {
      if (m.type === "set") this.set(m.key, m.value, { expireIn: m.expireIn });
      else if (m.type === "delete") this.delete(m.key);
      else if (m.type === "sum" || m.type === "min" || m.type === "max") this.#u64(m.type, m.key, (m.value as KvU64).value);
      else throw new TypeError(`unknown mutation type: ${m.type}`);
    }
    return this;
  }
  enqueue(): never {
    throw unsupported("Deno KV queues (enqueue)", "use Cloudflare Queues");
  }
  commit(): Promise<Commit> {
    return this.backend.commit(this.#checks, this.#mutations);
  }
}

// Deno cursors are padded base64url of the key bytes after the selector's common prefix.
const cursorOf = (b: Uint8Array) => {
  const s = encodeBase64Url(b);
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};

export class KvListIterator<T> implements AsyncIterableIterator<KvEntry<T>> {
  #cursor: string | undefined;
  #started = false;
  #gen: AsyncGenerator<KvEntry<T>>;

  constructor(backend: Backend, selector: KvListSelector, options: KvListOptions) {
    const sel = selector as { prefix?: Key; start?: Key; end?: Key };
    const jsel = {
      prefix: sel.prefix && keyToJSON(sel.prefix as KeyPart[]),
      start: sel.start && keyToJSON(sel.start as KeyPart[]),
      end: sel.end && keyToJSON(sel.end as KeyPart[]),
    };
    const { base } = selectorBounds(jsel); // validates the selector eagerly, as Deno does
    const limit = options.limit ?? Infinity;
    const batch = Math.max(1, Math.min(options.batchSize ?? 100, 1000));
    let after = options.cursor ? toHex(new Uint8Array([...base, ...decodeBase64Url(options.cursor)])) : undefined;
    // deno-lint-ignore no-this-alias
    const self = this;
    this.#gen = (async function* () {
      let remaining = limit;
      while (remaining > 0) {
        const want = Math.min(remaining, batch);
        const page = await backend.list(jsel, { limit: want, reverse: options.reverse, after });
        for (const r of page) {
          after = r.k;
          remaining--;
          const kb = fromHex(r.k);
          self.#cursor = cursorOf(kb.slice(base.length));
          yield { key: decodeKey(kb), value: toValue(JSON.parse(r.v)) as T, versionstamp: r.vs };
        }
        if (page.length < want) break;
      }
      // Deno: an exhausted list reports an empty cursor; one that stopped at `limit` keeps the last key.
      if (remaining > 0) self.#cursor = "";
    })();
  }

  get cursor(): string {
    if (!this.#started) throw new Error("Cannot get cursor before first iteration");
    return this.#cursor ?? "";
  }
  next(): Promise<IteratorResult<KvEntry<T>>> {
    this.#started = true;
    return this.#gen.next();
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

export class Kv {
  constructor(private backend: Backend) {}

  async get<T = unknown>(key: Key, _options?: { consistency?: string }): Promise<KvEntryMaybe<T>> {
    return (await this.getMany<[T]>([key]))[0];
  }
  async getMany<T extends readonly unknown[]>(
    keys: readonly Key[],
    _options?: { consistency?: string },
  ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    const rows = await this.backend.getMany(keys.map((k) => keyToJSON(k as KeyPart[])));
    return rows.map((r, i) => ({
      key: [...keys[i]],
      value: r.versionstamp === null ? null : toValue(r.value as never),
      versionstamp: r.versionstamp,
    })) as never;
  }
  set(key: Key, value: unknown, options?: { expireIn?: number }): Promise<{ ok: true; versionstamp: string }> {
    return this.atomic().set(key, value, options).commit() as Promise<{ ok: true; versionstamp: string }>;
  }
  async delete(key: Key): Promise<void> {
    await this.atomic().delete(key).commit();
  }
  list<T = unknown>(selector: KvListSelector, options: KvListOptions = {}): KvListIterator<T> {
    return new KvListIterator<T>(this.backend, selector, options);
  }
  atomic(): AtomicOperation {
    return new AtomicOperation(this.backend);
  }
  watch(): never {
    throw unsupported("kv.watch()", "use a Durable Object with WebSockets");
  }
  enqueue(): never {
    throw unsupported("Deno KV queues (enqueue)", "use Cloudflare Queues");
  }
  listenQueue(): never {
    throw unsupported("Deno KV queues (listenQueue)", "use a Cloudflare Queues consumer");
  }
  close(): void {}
  [Symbol.dispose]() {}
}

type Namespace = { idFromName(name: string): unknown; get(id: never): unknown };

/**
 * Open a Deno.Kv-compatible store backed by one DenoKvObject instance.
 * Safe at module scope: a fresh Durable Object stub is created for every call, because
 * Workers forbid I/O objects created outside a request or shared between requests.
 */
export function openKv(namespace: Namespace, name = "default"): Kv {
  const call = (method: string) => (...args: unknown[]) => {
    const stub = namespace.get(namespace.idFromName(name) as never) as Record<string, (...a: unknown[]) => unknown>;
    return stub[method](...args);
  };
  return new Kv({ getMany: call("getMany"), list: call("list"), commit: call("commit") } as Backend);
}

export { encodeKey };
