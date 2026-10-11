// Export a Deno KV store to `@deno/kv-utils`-compatible NDJSON.
//
//   deno run --unstable-kv -A tools/export.ts <kv path or KV Connect URL> [--out FILE] [--prefix JSON]
//
// For a local or self-hosted SQLite store (a file path), each entry that has an expiry also gets
// "expireAt" (ms since epoch) read from the store, because the Deno KV API never exposes expiry
// and a plain kv-utils export silently turns expiring keys into permanent ones.
// For a hosted store (KV Connect URL, token in DENO_KV_ACCESS_TOKEN) expiry is not readable:
// use tools/scan.ts to draft a TTL policy and pass it to tools/import.ts.
import { DatabaseSync } from "node:sqlite";
import { encodeKey, type KeyPart, toHex } from "../src/keys.ts";
import { entryToJSON, toKey } from "../src/vendor/kv_json.ts";

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
const out = arg("--out") ? await Deno.open(arg("--out")!, { write: true, create: true, truncate: true }) : Deno.stdout;

const isUrl = /^https?:\/\//.test(source);
const expiry = new Map<string, number>();
if (!isUrl) {
  const db = new DatabaseSync(source, { readOnly: true });
  for (
    const r of db.prepare("SELECT hex(k) AS h, expiration_ms AS e FROM kv WHERE expiration_ms >= 0").all() as { h: string; e: number }[]
  ) {
    expiry.set(r.h.toLowerCase(), r.e);
  }
  db.close();
}

const kv = await Deno.openKv(source);
const enc = new TextEncoder();
let n = 0, withExpiry = 0;
for await (const e of kv.list({ prefix: prefix as Deno.KvKey })) {
  const json = entryToJSON(e) as unknown as Record<string, unknown>;
  const exp = expiry.get(toHex(encodeKey(toKey(json.key as never) as KeyPart[])));
  if (exp !== undefined) {
    json.expireAt = exp;
    withExpiry++;
  }
  await out.write(enc.encode(JSON.stringify(json) + "\n"));
  n++;
}
kv.close();
console.error(
  `exported ${n} entries; ${withExpiry} with expireAt` +
    (isUrl ? " (hosted store: expiry not readable, use a TTL policy on import)" : " (read from the store's SQLite file)"),
);
