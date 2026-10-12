# deno-kv-workers

Move a Deno KV app from Deno Deploy to Cloudflare Workers **with its data and its KV semantics intact**, and check that nothing was lost.

- **A `Deno.Kv`-compatible client on a SQLite Durable Object.** It gives you tuple-key order identical to Deno KV, versionstamps, atomic
  `check`/`set`/`delete`/`sum`/`min`/`max`, `expireIn`, and `list` with prefix/start/end/reverse/limit/cursor. Most app code runs unchanged
  through a `Deno.openKv()` shim.
- **A TTL-preserving export and import.** Versionstamps are kept, large inputs are batched, and a per-prefix TTL policy applies where the
  source cannot tell you expiry.
- **A static `expireIn` scanner** that drafts that TTL policy from your own code.
- **A verify harness.** It replays one request script against the Deno app and the Worker, then diffs the responses and the stored KV state.

Free and MIT-licensed. Status: 0.1.1. Tested locally against `wrangler dev` (workerd), not yet against a deployed Cloudflare account. See
[Differences and limits](#differences-and-limits).

## Why not just map Deno KV to Workers KV?

Workers KV has no atomic check, no versionstamps, no ordered tuple keys and eventually consistent reads. The usual port is a get-then-put,
and these are the failures we measured:

| What we ran                                                                            | Deno KV              | Naive port                                          |
| -------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------- |
| 20 concurrent redemptions of one single-use link, real public app ported to Workers KV | 1 redirect, 19 × 410 | **20 redirects**                                    |
| Redemption racing a delete, same app                                                   | link stays deleted   | **deleted link comes back as a stored record**      |
| Example app in this repo, `check()` dropped (`test/naive-worker`), `tools/verify.ts`   | 1 redemption         | **up to 20 redemptions**; verify flagged 40/40 runs |

The data copy has its own trap. The Deno KV API never exposes an entry's expiry, so an export made with `@deno/kv-utils` (the documented
route) **turns every expiring key into a permanent one**. In a real view-counter app ported this way, a visitor who hit its 1-hour rate
limit stayed rate-limited forever and was never counted again.

A single Durable Object serializes commits the way `check()` expects, and SQLite keeps Deno's key order. This kit is that port, done once
and tested against real Deno KV.

## Quick start

Requirements: a Worker with Durable Objects on SQLite storage (available on the Workers Free plan), wrangler 4. You also need Deno 2.x to
run the tools.

```sh
npm install github:CyberNative-AI/deno-kv-workers#v0.1.1
```

The tools in steps 3–6 run with Deno from a pinned URL, because Deno does not run TypeScript from `node_modules`. Set this once, with the
same release as the install (a clone of this repo works too: use its `tools` directory):

```sh
T=https://raw.githubusercontent.com/CyberNative-AI/deno-kv-workers/v0.1.1/tools
```

**1. Bind the Durable Object** in `wrangler.jsonc`:

```jsonc
{
  "compatibility_date": "2026-10-01",
  "durable_objects": { "bindings": [{ "name": "DENO_KV", "class_name": "DenoKvObject" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DenoKvObject"] }]
}
```

**2. Keep your app code.** Import the shim first, and export the class:

```ts
import "deno-kv-workers/shim"; // installs Deno.openKv() and Deno.KvU64
import { DenoKvObject, handleMigration } from "deno-kv-workers";
import { handle } from "./app.ts"; // your existing handler, unchanged
export { DenoKvObject };

export default {
  async fetch(req: Request, env: Record<string, unknown>) {
    return (await handleMigration(req, env)) ?? handle(req, await Deno.openKv());
  },
};
```

A module-level `const kv = await Deno.openKv()` from the Deno version can stay. Remove the `Deno.serve(...)` call and export your handler
instead, as above. The handle works across requests because it creates a fresh Durable Object stub for each call (Workers reject a stub
shared between requests). You can also skip the shim: `import { openKv } from "deno-kv-workers"` and call `openKv(env.DENO_KV)`; at module
scope, take `env` from `import { env } from "cloudflare:workers"`.

[`examples/single-use-links`](examples/single-use-links) is a complete app that runs on both platforms.

**3. Draft a TTL policy** from your code:

```sh
deno run --allow-read --allow-write $T/scan.ts ./my-app --policy-out ttl-policy.json
```

Output on the test fixture ([`test/fixtures/scan-app/main.ts`](test/fixtures/scan-app/main.ts)):

```
expireIn writes: 6
  main.ts:7  key [RL_PREFIX, ip]  prefix ["ratelimit"]  expireIn HOUR = 3600000 ms
  main.ts:8  key ["uniq", ip]  prefix ["uniq"]  expireIn 24 * HOUR = 86400000 ms
  main.ts:10  key ["daily", day, ip]  prefix ["daily"]  expireIn 7 * 24 * 3600_000 = 604800000 ms
  main.ts:12  key ["sessions", sid]  prefix ["sessions"]  expireIn SESSION_TTL = 604800000 ms
  main.ts:13  key ["daily", "summary"]  prefix ["daily","summary"]  expireIn 30 * 24 * HOUR = 2592000000 ms
  main.ts:15  key key  prefix ["dynamic"]  expireIn ttl = ? ms

draft policy (5 prefixes):
  ["ratelimit"] expireIn 3600000 ms  (main.ts:7)
  ...
NEEDS REVIEW (1): prefix or duration not resolvable statically
  main.ts:15  key key  expireIn ttl
```

The scan is static and best-effort. It resolves literal key prefixes, constant arithmetic and same-file `const` names. If one prefix has
several windows, the scan keeps the longest, so no key expires earlier than it would on Deno. Review the draft before you use it.

**4. Export** the Deno KV data:

```sh
deno run --unstable-kv -A $T/export.ts path/to/kv.sqlite --out export.ndjson
```

The output is `@deno/kv-utils` NDJSON. If the source is a SQLite file (local Deno or self-hosted `denokv`), each expiring entry also gets
its exact `expireAt`, read from the file. An existing kv-utils export also works as input.

Stop writes to the source first. Deno KV has no snapshot read, so a list is read page by page, and an export taken while the app
still writes can hold a state that never existed: in our test, an export taken during atomic transfers lost one or two units from a
balance total that every commit kept constant. The export therefore lists the store a second time and compares every key,
versionstamp and expiry. If anything changed, it exits with code 3 and writes nothing. Put the app in maintenance mode (or make it
read-only) and run it again. Keys that expire during the export also count as changes. For a local file, stopping writes also protects
the app: the export opens the file with `Deno.openKv`, and in our test that made occasional concurrent commits of the app fail with
`database is locked`.

The export is written to a temporary file next to `--out` and replaces `--out` only when it is complete and checked, so a
failed, refused or interrupted (Ctrl-C) run leaves an earlier export there unchanged. Without `--out` the export goes to stdout, which
needs `--no-recheck`: lines already printed cannot be taken back.

`--no-recheck` skips the second pass, and with it both guarantees: the copy can hold a state that never existed, and a key written
during the export can carry a stale or missing `expireAt`. `--prefix '["users"]'` exports one prefix; the check then covers only that
prefix, so the copy is consistent only inside it, and separate exports of different prefixes are not consistent with each other.

**5. Import** it into the Worker, through the migration route `handleMigration` exposes:

```sh
wrangler secret put KV_MIGRATION_TOKEN     # temporary; delete it after the migration
KV_MIGRATION_TOKEN=... deno run -A $T/import.ts --url https://my-app.example.workers.dev \
  --in export.ndjson --policy ttl-policy.json
```

The import preserves versionstamps, so new writes sort after the imported ones. It sends batches of up to 1 MB / 5,000 entries
(`--batch-bytes`, `--batch-entries`, `--dry-run`) and skips entries that have already expired. **On the Workers Free plan, add
`--batch-entries 100`.** Free Workers get 10 ms of CPU per request; in our local measurement a 5,000-entry batch needed about 30 ms in the
Worker alone, and about 0.06 ms per entry in total. A batch that fails can be sent again: the rerun writes the same entries. An entry with
an exact `expireAt` keeps it. Otherwise the longest matching policy prefix applies, counted from import time. The route answers 404 unless
the token is set and matches.

**6. Verify** before you switch traffic. Run the same request script against the Deno app and the Worker:

```sh
KV_MIGRATION_TOKEN=... deno run --unstable-kv -A $T/verify.ts script.json \
  --a http://127.0.0.1:8000 --b http://127.0.0.1:8787 --state-a-kv kv.sqlite --state-b worker
```

```
responses: 22/22 steps identical after normalization
state: 10 vs 10 entries; 0 differing entries
note: 8 concurrent steps are samples; a clean result covers only the races hit
RESULT: no differences
```

A script is a list of HTTP steps. Each step can run concurrently (`"concurrent": 20`), save a response field for later steps, or sleep. A
concurrent step is one sample of a race, and a race can happen to serialize: on the check-dropping control, 1 in 10 of our 20-way races
showed a single winner, exactly as a correct port does. Race each check-guarded path several times, each on fresh data; the example races 8
links. `verify` prints a note when a script has concurrent steps. Regex `normalize` rules mask generated ids and times. See
[`examples/single-use-links/script.json`](examples/single-use-links/script.json). The exit code is 1 when anything differs, so the check
also works in CI. Run it on copies of your data, not against production.

## What is tested

`sh test/run.sh` starts a local Worker under `wrangler dev` and compares it with real Deno KV (Deno 2.9.7, wrangler 4.149.0):

- **Key encoding and order:** 1,800 random mixed-type keys (bytes, strings with NUL and non-ASCII characters, ±0, NaN, ±Infinity, bigints up
  to 2^200, booleans). The encoded bytes are identical to what Deno KV writes to SQLite, and the sort order is identical to `kv.list()`.
- **Behaviour:** four randomized programs of 250 operations each (`set`, `delete`, `get`, `getMany`, `list` with
  prefix/start/end/reverse/limit/batchSize/cursor, atomic commits with passing and failing checks, `sum`/`min`/`max`, sums on non-U64
  values, invalid selectors). Every result and error message equals Deno's. Versionstamps are compared by order.
- **Concurrency:** 20 concurrent check-guarded commits. Exactly one wins on each platform.
- **Module-level handle:** one `await Deno.openKv()` at module scope serves sequential and 20-way concurrent requests correctly.
- **TTL:** an expired key is hidden at once and deleted by the Durable Object alarm. After Deno's own sweep, the results match Deno's.
- **Migration:** export, then import in batches. Keys, values, versionstamps and exact expiry survive, new writes sort after imported ones,
  and a wrong token gets 404.
- **Scanner** on a fixture with constants, atomic writes, and strings and comments that must be ignored.
- **Verify:** the example script races 8 fresh links 20 ways each. The example app has no differences on the port, and the check-dropping
  control is flagged.
- **Unsupported calls** throw explicit errors.

## Differences and limits

- **Not supported:** `kv.watch()`, queues (`enqueue`, `listenQueue`), and `Deno.openKv(path)`. Each throws an error that names the
  Cloudflare alternative. Consistency options are accepted and ignored: every read is strongly consistent.
- **Expiry is stricter than Deno's.** Deno can serve an expired key until its background sweep. This port hides it at once.
- **Hosted Deno Deploy export is untested.** `tools/export.ts` accepts a KV Connect URL with `DENO_KV_ACCESS_TOKEN`. Against a
  self-hosted `denokv` 0.14.0 server it exported the same entries, in the same order, as a direct read of the store's file. We have not
  run it against a hosted database. Exact expiry is never readable over KV Connect. Use the scanner's TTL policy instead.
- **One Durable Object holds one KV database.** All commits are serialized, which is what makes `check()` exact. Throughput is that of one
  Durable Object, and storage is capped by the Durable Object SQLite limit. An app that needs more must shard by key prefix itself. This kit
  does not do that for you.
- **Policy expiry counts from import time,** so a key can outlive its original deadline by up to one window. It never expires earlier.
- **`@deno/kv-utils` writes key part `-0` as `0`.** This kit's export keeps `-0`, and its import accepts both.
- **Production Workers behaviour** (deployed Durable Objects, real network latency, CPU limits) has not been measured by us. Run
  `tools/verify.ts` against a staging Worker before you switch traffic. Cloudflare does not generate preview URLs for a Worker that
  implements a Durable Object, so deploy a separate one (for example `wrangler deploy --env staging`). Unless its binding sets `script_name`
  to the production Worker, its Durable Objects have their own storage, so the script's writes stay out of production.
- **A port can still change behaviour outside KV.** One app we ported recorded `cf-connecting-ip` where Deno had stored `null`. The verify
  diff surfaced it.

## Licence

MIT, © 2026 CyberNative AI LLC. `src/vendor/kv_json.ts` is derived from [`@deno/kv-utils`](https://jsr.io/@deno/kv-utils) 0.1.4, © the Deno
authors, MIT ([notice](src/vendor/LICENSE)).
