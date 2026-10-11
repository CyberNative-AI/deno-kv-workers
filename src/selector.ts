// Pure helpers shared by the Durable Object and the client (no Workers imports).
import { compareBytes, encodeKey, type Key } from "./keys.ts";
import { toKey } from "./vendor/kv_json.ts";
import type { KvKeyJSON } from "./vendor/kv_json.ts";

export type ListSelectorJSON = { prefix?: KvKeyJSON; start?: KvKeyJSON; end?: KvKeyJSON };
const enc = (key: KvKeyJSON) => encodeKey(toKey(key) as Key);

export function nextVersionstamp(last: string): string {
  return (BigInt("0x" + last.slice(0, 16)) + 1n).toString(16).padStart(16, "0") + "0000";
}

export function selectorBounds(sel: ListSelectorJSON): { lo: Uint8Array; loIncl: boolean; hi: Uint8Array; base: Uint8Array } {
  if (sel.prefix) {
    const p = enc(sel.prefix);
    const end = new Uint8Array([...p, 0xff]);
    const start = sel.start ? enc(sel.start) : undefined;
    const stop = sel.end ? enc(sel.end) : undefined;
    if (start && !startsWith(start, p)) throw new TypeError("Start key is not in the keyspace defined by prefix");
    if (stop && !startsWith(stop, p)) throw new TypeError("End key is not in the keyspace defined by prefix");
    if (start && stop && compareBytes(start, stop) > 0) throw new TypeError("Start key is greater than end key");
    return { lo: start ?? p, loIncl: !!start, hi: stop ?? end, base: p };
  }
  if (!sel.start || !sel.end) throw new TypeError("Selector must specify either 'prefix' or both 'start' and 'end' key");
  const lo = enc(sel.start), hi = enc(sel.end);
  if (compareBytes(lo, hi) > 0) throw new TypeError("Start key is greater than end key");
  let n = 0;
  while (n < lo.length && n < hi.length && lo[n] === hi[n]) n++;
  return { lo, loIncl: true, hi, base: lo.slice(0, n) };
}

function startsWith(a: Uint8Array, p: Uint8Array) {
  if (a.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (a[i] !== p[i]) return false;
  return true;
}
