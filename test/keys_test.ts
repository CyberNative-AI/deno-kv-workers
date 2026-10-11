// Key encoding parity against real Deno KV: for randomized mixed-type keys, our encoding must
// equal the bytes Deno writes to its SQLite store, and our byte order must equal kv.list() order.
import { DatabaseSync } from "node:sqlite";
import { deepStrictEqual as assertEquals } from "node:assert";
import { compareBytes, decodeKey, encodeKey, type KeyPart, toHex } from "../src/keys.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STR_POOL = ["", "a", "ab", "a\0", "a\0b", "\0", "z", "ü", "路径", "😀", "A", "a b", "\xff"];
const NUM_POOL = [0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 1e300, Infinity, -Infinity, NaN, 2 ** 53, -(2 ** 53)];
const BIG_POOL = [0n, 1n, -1n, 255n, 256n, -255n, -256n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 64n, -(2n ** 64n), 2n ** 200n, -(2n ** 200n)];

function randomPart(r: () => number): KeyPart {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  switch (Math.floor(r() * 5)) {
    case 0: {
      const n = Math.floor(r() * 4);
      return Uint8Array.from({ length: n }, () => pick([0, 1, 0xfe, 0xff, Math.floor(r() * 256)]));
    }
    case 1:
      return r() < 0.7 ? pick(STR_POOL) : pick(STR_POOL) + pick(STR_POOL);
    case 2:
      return r() < 0.6 ? pick(NUM_POOL) : (r() - 0.5) * 10 ** Math.floor(r() * 20 - 10);
    case 3:
      return r() < 0.6 ? pick(BIG_POOL) : BigInt(Math.floor((r() - 0.5) * 2 ** 40)) * BigInt(Math.floor(r() * 2 ** 30));
    default:
      return r() < 0.5;
  }
}

for (const seed of [1, 2, 3]) {
  Deno.test(`key encoding and order match Deno KV (seed ${seed}, 600 random keys)`, async () => {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/kv.sqlite`;
    const r = rng(seed);
    const kv = await Deno.openKv(path);
    const written = new Map<string, KeyPart[]>();
    for (let i = 0; i < 600; i++) {
      const key = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomPart(r));
      await kv.set(key, i);
      written.set(toHex(encodeKey(key)), key);
    }
    const denoOrder: string[] = [];
    for await (const e of kv.list({ prefix: [] })) denoOrder.push(toHex(encodeKey(e.key as KeyPart[])));
    kv.close();

    // 1. our encoding equals Deno's stored bytes, key by key
    const db = new DatabaseSync(path);
    const stored = (db.prepare("SELECT hex(k) AS h FROM kv ORDER BY k").all() as { h: string }[]).map((x) => x.h.toLowerCase());
    db.close();
    assertEquals(new Set(stored), new Set(written.keys()));
    // 2. sorting by our bytes gives Deno's list order
    const ours = [...written.keys()].sort((a, b) =>
      compareBytes(
        Uint8Array.from(a.match(/../g)!.map((h) => parseInt(h, 16))),
        Uint8Array.from(b.match(/../g)!.map((h) => parseInt(h, 16))),
      )
    );
    assertEquals(ours, denoOrder);
    // 3. decode round-trips (NaN and -0 compared by encoding)
    for (const [h, key] of written) assertEquals(toHex(encodeKey(decodeKey(encodeKey(key)))), h);
    await Deno.remove(dir, { recursive: true });
  });
}
