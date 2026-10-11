// Export a Deno KV store to `@deno/kv-utils`-compatible NDJSON.
//
//   deno run --unstable-kv -A tools/export.ts <kv path or KV Connect URL> [--out FILE] [--prefix JSON] [--no-recheck]
//
// Deno KV has no snapshot read: a list is fetched page by page, so an export taken while the app
// still writes can hold a state that never existed (half of an atomic commit). After the export the
// tool lists the store a second time and compares every key, versionstamp and expiry. If anything changed,
// the export is not a consistent copy: it exits 3 and deletes the --out file. Stop writes to the
// source (or put the app in maintenance mode) and run it again. --no-recheck skips the second pass.
//
// For a local or self-hosted SQLite store (a file path), each entry that has an expiry also gets
// "expireAt" (ms since epoch) read from the store, because the Deno KV API never exposes expiry
// and a plain kv-utils export silently turns expiring keys into permanent ones.
// For a hosted store (KV Connect URL, token in DENO_KV_ACCESS_TOKEN) expiry is not readable:
// use tools/scan.ts to draft a TTL policy and pass it to tools/import.ts.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { encodeKey, type KeyPart, toHex } from "../src/keys.ts";
import { entryToJSON } from "../src/vendor/kv_json.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const source = Deno.args.find((a, i) => !a.startsWith("--") && !Deno.args[i - 1]?.startsWith("--"));
if (!source) {
  console.error("usage: tools/export.ts <kv path or KV Connect URL> [--out FILE] [--prefix '[\"users\"]']");
  Deno.exit(2);
}
const prefix = arg("--prefix") ? (JSON.parse(arg("--prefix")!) as KeyPart[]) : [];
const outPath = arg("--out");
const out = outPath ? await Deno.open(outPath, { write: true, create: true, truncate: true }) : Deno.stdout;
const recheck = !Deno.args.includes("--no-recheck");

const isUrl = /^https?:\/\//.test(source);
// Expiry by key (hex of the encoded key), read from the store's SQLite file. Empty for a hosted store.
function readExpiry(): Map<string, number> {
  const expiry = new Map<string, number>();
  if (isUrl) return expiry;
  const db = new DatabaseSync(source!, { readOnly: true });
  for (
    const r of db.prepare("SELECT hex(k) AS h, expiration_ms AS e FROM kv WHERE expiration_ms >= 0").all() as { h: string; e: number }[]
  ) {
    expiry.set(r.h.toLowerCase(), r.e);
  }
  db.close();
  return expiry;
}
const keyHex = (e: Deno.KvEntry<unknown>) => toHex(encodeKey(e.key as KeyPart[]));

const expiry = readExpiry();
const kv = await Deno.openKv(source);
const enc = new TextEncoder();
// One line per entry: key bytes, versionstamp and expiry. Pass 1 hashes the expiry it writes, from a map
// read before pass 1; pass 2 hashes expiry from a map read again after pass 1 ended (time T).
// Every commit to a key gives it a new, larger versionstamp, and a key's expiry changes only with a
// commit. So if a key has the same versionstamp in both passes, no commit touched it between its pass-1
// read and its pass-2 read, and that version was the live one at T. The map read at T therefore holds
// that version's own expiry. Equal digests mean: the same keys with the same versionstamps (pass 1 equals
// the store as it was at T), and each exported expireAt equals the second map's value, which is the
// expiry of the exported version. A key written or re-written after the first map was read but before
// pass 1 read it (same versionstamp in both passes, stale or missing expiry in the first map) changes the
// digest. Without the recheck, an expireAt can belong to an older version of its key.
const stamp = (h: ReturnType<typeof createHash>, e: Deno.KvEntry<unknown>, exp: number | undefined) =>
  h.update(keyHex(e) + " " + e.versionstamp + " " + (exp ?? "-") + "\n");
const first = createHash("sha256");
let n = 0, withExpiry = 0;
for await (const e of kv.list({ prefix: prefix as Deno.KvKey })) {
  const json = entryToJSON(e) as unknown as Record<string, unknown>;
  const exp = expiry.get(keyHex(e));
  stamp(first, e, exp);
  if (exp !== undefined) {
    json.expireAt = exp;
    withExpiry++;
  }
  await out.write(enc.encode(JSON.stringify(json) + "\n"));
  n++;
}
let changed = false, n2 = 0;
if (recheck) {
  const second = createHash("sha256");
  const expiryAtT = readExpiry();
  for await (const e of kv.list({ prefix: prefix as Deno.KvKey })) {
    stamp(second, e, expiryAtT.get(keyHex(e)));
    n2++;
  }
  changed = first.digest("hex") !== second.digest("hex");
}
kv.close();
if (outPath) out.close();
if (changed) {
  if (outPath) await Deno.remove(outPath);
  console.error(
    `export NOT consistent: the store changed while it was read (${n} entries, then ${n2} on the recheck)` +
      (outPath ? `; deleted ${outPath}` : "; discard this output") +
      ".\nStop writes to the source (or put the app in maintenance mode) and run the export again." +
      " Keys that expire during the export also count as changes.",
  );
  Deno.exit(3);
}
console.error(
  `exported ${n} entries; ${withExpiry} with expireAt` +
    (isUrl ? " (hosted store: expiry not readable, use a TTL policy on import)" : " (read from the store's SQLite file)") +
    (recheck ? "; recheck: unchanged" : "; recheck skipped"),
);
