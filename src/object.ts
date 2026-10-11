// A SQLite-backed Durable Object that stores Deno KV data with Deno KV semantics:
// ordered tuple keys, versionstamps, serialized atomic commits with checks,
// sum/min/max, expireIn (hidden on read, removed by an alarm), and prefix/range lists.
import { DurableObject } from "cloudflare:workers";
import { decodeKey, encodeKey, fromHex, type Key, toHex } from "./keys.ts";
import { type ListSelectorJSON, nextVersionstamp, selectorBounds } from "./selector.ts";
import { keyToJSON, toKey } from "./vendor/kv_json.ts";
import type { KvKeyJSON, KvValueJSON } from "./vendor/kv_json.ts";

export type CheckJSON = { key: KvKeyJSON; versionstamp: string | null };
export type MutationJSON = {
  type: "set" | "delete" | "sum" | "min" | "max";
  key: KvKeyJSON;
  value?: KvValueJSON;
  expireIn?: number;
};
export type { ListSelectorJSON };
export type ListPage = { k: string; v: string; vs: string }[];
/** One line of `@deno/kv-utils` export NDJSON, plus an optional absolute expiry (ms since epoch). */
export type ImportEntry = { key: KvKeyJSON; value: KvValueJSON; versionstamp: string; expireAt?: number | null };

type Row = { k: ArrayBuffer; v: string; vs: string; exp: number | null };
const U64_MASK = 0xffffffffffffffffn;
const enc = (key: KvKeyJSON) => encodeKey(toKey(key) as Key);

export class DenoKvObject extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (k BLOB PRIMARY KEY, v TEXT NOT NULL, vs TEXT NOT NULL, exp INTEGER)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv_meta (id INTEGER PRIMARY KEY CHECK (id = 0), vs TEXT NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO kv_meta VALUES (0, '00000000000000000000')");
  }

  private row(k: Uint8Array, now = Date.now()): Row | undefined {
    const r = this.sql.exec<Row>("SELECT k, v, vs, exp FROM kv WHERE k = ?", k).toArray()[0];
    return r && (r.exp === null || r.exp > now) ? r : undefined;
  }

  private lastVs(): string {
    return this.sql.exec<{ vs: string }>("SELECT vs FROM kv_meta WHERE id = 0").one().vs;
  }

  getMany(keys: KvKeyJSON[]): { value: KvValueJSON | null; versionstamp: string | null }[] {
    const now = Date.now();
    return keys.map((key) => {
      const r = this.row(enc(key), now);
      return r ? { value: JSON.parse(r.v), versionstamp: r.vs } : { value: null, versionstamp: null };
    });
  }

  list(sel: ListSelectorJSON, opts: { limit: number; reverse?: boolean; after?: string }): ListPage {
    const { lo, loIncl, hi } = selectorBounds(sel);
    let q = `SELECT k, v, vs FROM kv WHERE k ${loIncl ? ">=" : ">"} ? AND k < ? AND (exp IS NULL OR exp > ?)`;
    const args: unknown[] = [lo, hi, Date.now()];
    if (opts.after) {
      q += opts.reverse ? " AND k < ?" : " AND k > ?";
      args.push(fromHex(opts.after));
    }
    q += ` ORDER BY k ${opts.reverse ? "DESC" : "ASC"} LIMIT ?`;
    args.push(opts.limit);
    return this.sql.exec<Row>(q, ...args).toArray().map((r) => ({ k: toHex(new Uint8Array(r.k)), v: r.v, vs: r.vs }));
  }

  async commit(checks: CheckJSON[], mutations: MutationJSON[]): Promise<{ ok: true; versionstamp: string } | { ok: false }> {
    let minExp: number | null = null;
    let failure: Error | null = null;
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const c of checks) {
        if ((this.row(enc(c.key), now)?.vs ?? null) !== c.versionstamp) return { ok: false as const };
      }
      const vs = nextVersionstamp(this.lastVs());
      this.sql.exec("UPDATE kv_meta SET vs = ? WHERE id = 0", vs);
      for (const m of mutations) {
        const k = enc(m.key);
        if (m.type === "delete") {
          this.sql.exec("DELETE FROM kv WHERE k = ?", k);
          continue;
        }
        let value = m.value!;
        if (m.type !== "set") {
          if (value.type !== "KvU64") throw new TypeError(`Value must be a Deno.KvU64 for '${m.type}'`);
          const cur = this.row(k, now);
          if (cur) {
            const cv = JSON.parse(cur.v) as KvValueJSON;
            if (cv.type !== "KvU64") {
              // Matches Deno KV (local SQLite backend, Deno 2.9): mutations before the failing one
              // stay committed, later ones are dropped, and commit() throws.
              failure = new TypeError(`Failed to perform '${m.type}' mutation on a non-U64 value in the database`);
              break;
            }
            const a = BigInt(cv.value as string), b = BigInt(value.value as string);
            const r = m.type === "sum" ? (a + b) & U64_MASK : m.type === "min" ? (a < b ? a : b) : (a > b ? a : b);
            value = { type: "KvU64", value: r.toString() } as KvValueJSON;
          }
        }
        const exp = m.expireIn != null ? now + m.expireIn : null;
        if (exp !== null) minExp = minExp === null ? exp : Math.min(minExp, exp);
        this.sql.exec("INSERT OR REPLACE INTO kv (k, v, vs, exp) VALUES (?, ?, ?, ?)", k, JSON.stringify(value), vs, exp);
      }
      return { ok: true as const, versionstamp: vs };
    });
    if (minExp !== null) await this.armAlarm(minExp);
    if (failure as Error | null) throw failure;
    return result;
  }

  private async armAlarm(at?: number) {
    if (at === undefined) {
      const next = this.sql.exec<{ m: number | null }>("SELECT MIN(exp) AS m FROM kv WHERE exp IS NOT NULL").one().m;
      if (next === null) return;
      at = next;
    }
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  override async alarm() {
    this.sql.exec("DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?", Date.now());
    await this.armAlarm();
  }

  /** Import entries as-is: versionstamps are preserved and later writes sort after them. */
  async importEntries(entries: ImportEntry[]): Promise<{ imported: number; skippedExpired: number; lastVersionstamp: string }> {
    const now = Date.now();
    let skippedExpired = 0;
    const out = this.ctx.storage.transactionSync(() => {
      let last = this.lastVs();
      for (const e of entries) {
        if (!/^[0-9a-f]{20}$/.test(e.versionstamp)) throw new TypeError(`bad versionstamp: ${e.versionstamp}`);
        if (e.expireAt != null && e.expireAt <= now) {
          skippedExpired++;
          continue;
        }
        this.sql.exec(
          "INSERT OR REPLACE INTO kv (k, v, vs, exp) VALUES (?, ?, ?, ?)",
          enc(e.key),
          JSON.stringify(e.value),
          e.versionstamp,
          e.expireAt ?? null,
        );
        if (e.versionstamp > last) last = e.versionstamp;
      }
      this.sql.exec("UPDATE kv_meta SET vs = ? WHERE id = 0", last);
      return { imported: entries.length - skippedExpired, skippedExpired, lastVersionstamp: last };
    });
    await this.armAlarm();
    return out;
  }

  /** Every live entry in key order, as `@deno/kv-utils` NDJSON objects with `expireAt` when set. */
  exportEntries(opts: { after?: string; limit?: number } = {}): (ImportEntry & { k: string })[] {
    const rows = this.sql.exec<Row>(
      "SELECT k, v, vs, exp FROM kv WHERE k > ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?",
      fromHex(opts.after ?? ""),
      Date.now(),
      opts.limit ?? 1000,
    ).toArray();
    return rows.map((r) => {
      const kb = new Uint8Array(r.k);
      const e: ImportEntry & { k: string } = { k: toHex(kb), key: keyToJSON(decodeKey(kb)), value: JSON.parse(r.v), versionstamp: r.vs };
      if (r.exp !== null) e.expireAt = r.exp;
      return e;
    });
  }
}
