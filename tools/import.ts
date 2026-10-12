// Import Deno KV NDJSON (from tools/export.ts or `@deno/kv-utils` exportEntries) into a Worker
// that serves the /__kv/import route (src/migrate.ts). Versionstamps are preserved.
//
//   KV_MIGRATION_TOKEN=... deno run -A tools/import.ts --url http://127.0.0.1:8787 --in export.ndjson \
//       [--policy ttl-policy.json] [--batch-bytes 1000000] [--batch-entries 5000] [--dry-run]
//
// On the Workers Free plan each request gets 10 ms of CPU, and a full batch needs far more:
// use --batch-entries 100 there. Batches before a failed one stay imported. Sending any batch again
// writes the same keys, values and versionstamps, so a rerun is harmless before the Worker takes traffic.
//
// TTL policy (draft one with tools/scan.ts):
//   { "rules": [ { "prefix": ["ratelimit"], "expireIn": 3600000 } ] }
// Prefix parts are plain strings or kv-utils JSON parts ({"type":"bigint","value":"1"}).
// The longest matching prefix wins. Entries that already carry "expireAt" (read from a local or
// self-hosted store) keep it. Policy expiry counts from import time, so a key can outlive its
// original deadline by up to one window; it never expires earlier than on Deno.
import { encodeKey, type KeyPart, toHex } from "../src/keys.ts";
import { toKey } from "../src/vendor/kv_json.ts";

type Entry = { key: unknown[]; value: unknown; versionstamp: string; expireAt?: number | null };
type Rule = { prefix: unknown[]; expireIn: number };

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

export function compilePolicy(rules: Rule[]) {
  const compiled = rules.map((r) => {
    if (!(r.expireIn > 0)) throw new Error(`policy rule ${JSON.stringify(r.prefix)}: expireIn must be > 0 ms`);
    const parts = r.prefix.map((p) => typeof p === "string" ? { type: "string", value: p } : p);
    return { hex: toHex(encodeKey(toKey(parts as never) as KeyPart[])), expireIn: r.expireIn, label: JSON.stringify(r.prefix), hits: 0 };
  }).sort((a, b) => b.hex.length - a.hex.length);
  return {
    rules: compiled,
    match(keyHex: string) {
      return compiled.find((r) => keyHex.startsWith(r.hex) && keyHex.length > r.hex.length);
    },
  };
}

export function applyPolicy(entries: Entry[], rules: Rule[], now: number) {
  const policy = compilePolicy(rules);
  let exact = 0;
  for (const e of entries) {
    if (e.expireAt != null) {
      exact++;
      continue;
    }
    const r = policy.match(toHex(encodeKey(toKey(e.key as never) as KeyPart[])));
    if (r) {
      e.expireAt = now + r.expireIn;
      r.hits++;
    }
  }
  return { exact, rules: policy.rules.map(({ label, expireIn, hits }) => ({ prefix: label, expireIn, hits })) };
}

if (import.meta.main) {
  const url = arg("--url"), input = arg("--in");
  const token = Deno.env.get("KV_MIGRATION_TOKEN");
  if (!url || !input) {
    console.error(
      "usage: KV_MIGRATION_TOKEN=... tools/import.ts --url WORKER_URL --in FILE.ndjson [--policy FILE] [--batch-bytes N] [--batch-entries N] [--dry-run]",
    );
    Deno.exit(2);
  }
  const maxBytes = Number(arg("--batch-bytes") ?? 1_000_000);
  const maxEntries = Number(arg("--batch-entries") ?? 5000);
  if (!(Number.isInteger(maxBytes) && maxBytes > 0) || !(Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 5000)) {
    console.error("--batch-bytes must be a positive integer and --batch-entries an integer from 1 to 5000");
    Deno.exit(2);
  }
  const dry = Deno.args.includes("--dry-run");
  if (!token && !dry) {
    console.error("set KV_MIGRATION_TOKEN (the same value as the Worker's KV_MIGRATION_TOKEN secret)");
    Deno.exit(2);
  }
  const entries = (await Deno.readTextFile(input)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Entry);
  const rules: Rule[] = arg("--policy") ? JSON.parse(await Deno.readTextFile(arg("--policy")!)).rules : [];
  const report = applyPolicy(entries, rules, Date.now());
  const withTtl = entries.filter((e) => e.expireAt != null).length;
  console.error(`${entries.length} entries; ${report.exact} with exact expireAt; ${withTtl - report.exact} given expiry by policy`);
  for (const r of report.rules) console.error(`  policy ${r.prefix} expireIn=${r.expireIn}ms -> ${r.hits} entries`);
  if (rules.length === 0 && report.exact === 0) {
    console.error("warning: no TTL policy and no exact expiry: every imported key will be permanent");
  }

  const batches: string[][] = [[]];
  let size = 0;
  for (const e of entries) {
    const line = JSON.stringify(e);
    if ((size + line.length > maxBytes || batches.at(-1)!.length >= maxEntries) && batches.at(-1)!.length) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(line);
    size += line.length + 1;
  }
  if (dry) {
    console.error(`dry run: ${batches.length} batch(es), nothing sent`);
    Deno.exit(0);
  }
  let imported = 0, skipped = 0;
  for (const [i, b] of batches.entries()) {
    const res = await fetch(new URL("/__kv/import", url), {
      method: "POST",
      headers: { "x-kv-migration-token": token!, "content-type": "application/x-ndjson" },
      body: b.join("\n") + "\n",
    });
    if (!res.ok) {
      console.error(`batch ${i + 1}/${batches.length} failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
      if (res.status >= 500) {
        console.error(
          `${i} batch(es) before it were imported. If the Worker is on the Workers Free plan (10 ms CPU per request),` +
            " run the import again with --batch-entries 100. Importing the same entries again is harmless" +
            " as long as the Worker has not taken traffic yet.",
        );
      }
      Deno.exit(1);
    }
    const r = await res.json() as { imported: number; skippedExpired: number };
    imported += r.imported;
    skipped += r.skippedExpired;
  }
  console.error(`imported ${imported} entries in ${batches.length} batch(es); skipped ${skipped} already expired`);
}
