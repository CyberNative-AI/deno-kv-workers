// A JSON op interpreter that runs identically against real Deno KV and against the Workers port.
// Results are JSON (kv-utils encoding) so the two runs can be compared exactly.
import { keyToJSON, toKey, toValue, valueToJSON } from "../src/vendor/kv_json.ts";
import type { KvKeyJSON, KvValueJSON } from "../src/vendor/kv_json.ts";

// deno-lint-ignore no-explicit-any
type AnyKv = any;
export type Op =
  | { op: "set"; key: KvKeyJSON; value: KvValueJSON; expireIn?: number }
  | { op: "delete"; key: KvKeyJSON }
  | { op: "get"; key: KvKeyJSON; slot?: string }
  | { op: "getMany"; keys: KvKeyJSON[] }
  | {
    op: "list";
    selector: { prefix?: KvKeyJSON; start?: KvKeyJSON; end?: KvKeyJSON };
    limit?: number;
    reverse?: boolean;
    batchSize?: number;
    cursorSlot?: string;
    saveCursor?: string;
  }
  | {
    op: "atomic";
    checks: { key: KvKeyJSON; slot: string | null }[];
    mutations: { type: "set" | "delete" | "sum" | "min" | "max"; key: KvKeyJSON; value?: KvValueJSON; expireIn?: number }[];
  };

export type Slots = Record<string, string | null>;

const entry = (e: { key: unknown[]; value: unknown; versionstamp: string | null }) => ({
  key: keyToJSON(e.key as never),
  value: e.versionstamp === null ? null : valueToJSON(e.value),
  versionstamp: e.versionstamp,
});

export async function runOp(kv: AnyKv, op: Op, slots: Slots): Promise<unknown> {
  try {
    switch (op.op) {
      case "set": {
        const r = await kv.set(toKey(op.key), toValue(op.value), op.expireIn ? { expireIn: op.expireIn } : undefined);
        return { ok: r.ok, versionstamp: r.versionstamp };
      }
      case "delete":
        return { deleted: await kv.delete(toKey(op.key)) ?? null };
      case "get": {
        const e = await kv.get(toKey(op.key));
        if (op.slot) slots[op.slot] = e.versionstamp;
        return entry(e);
      }
      case "getMany":
        return (await kv.getMany(op.keys.map((k) => toKey(k)))).map(entry);
      case "list": {
        const cursor = op.cursorSlot ? slots[op.cursorSlot] ?? undefined : undefined;
        const it = kv.list(
          Object.fromEntries(Object.entries(op.selector).filter(([, v]) => v).map(([k, v]) => [k, toKey(v!)])),
          { limit: op.limit, reverse: op.reverse, batchSize: op.batchSize, cursor },
        );
        const out = [];
        for await (const e of it) out.push(entry(e));
        if (op.saveCursor) slots[op.saveCursor] = it.cursor;
        return { entries: out, cursor: it.cursor };
      }
      case "atomic": {
        const a = kv.atomic();
        for (const c of op.checks) a.check({ key: toKey(c.key), versionstamp: c.slot === null ? null : slots[c.slot] ?? null });
        for (const m of op.mutations) {
          if (m.type === "set") a.set(toKey(m.key), toValue(m.value!), m.expireIn ? { expireIn: m.expireIn } : undefined);
          else if (m.type === "delete") a.delete(toKey(m.key));
          else a[m.type](toKey(m.key), (toValue(m.value!) as { value: bigint }).value);
        }
        const r = await a.commit();
        return r.ok ? { ok: true, versionstamp: r.versionstamp } : { ok: false };
      }
    }
  } catch (e) {
    return { error: (e as Error).constructor.name, message: (e as Error).message };
  }
}
