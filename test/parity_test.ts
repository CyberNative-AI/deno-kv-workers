// Behaviour parity: identical randomized op programs run against real Deno KV and against the
// Workers port (test Worker on TEST_WORKER_URL, started by test/run.sh). Results must match exactly,
// except versionstamps, which are compared by order of first appearance.
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { type Op, runOp, type Slots } from "./ops.ts";
import { keyToJSON, valueToJSON } from "../src/vendor/kv_json.ts";
import type { KvKeyJSON, KvValueJSON } from "../src/vendor/kv_json.ts";

const WORKER = Deno.env.get("TEST_WORKER_URL") ?? "http://127.0.0.1:8799";
const TOKEN = "local-test-token";

async function onWorker(run: string, ops: Op[]): Promise<unknown[]> {
  const res = await fetch(`${WORKER}/__test/ops`, { method: "POST", body: JSON.stringify({ run, ops }) });
  if (!res.ok) throw new Error(`worker: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function onDeno(kv: Deno.Kv, ops: Op[], slots: Slots): Promise<unknown[]> {
  const out = [];
  for (const op of ops) out.push(await runOp(kv, op, slots));
  return out;
}

// Versionstamps differ between stores; map each to its rank of first appearance per run.
export function normalizeStamps(results: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(results), (k, v) => {
    if (k === "versionstamp" && typeof v === "string") {
      if (!seen.has(v)) seen.set(v, `vs#${seen.size}`);
      return seen.get(v);
    }
    return v;
  });
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function program(seed: number, n: number, ns: string): Op[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const parts = [
    "",
    "a",
    "b",
    "a\0",
    "z",
    "ü",
    0,
    -1,
    1.5,
    NaN,
    -0,
    0n,
    7n,
    -(2n ** 70n),
    true,
    false,
    new Uint8Array([0]),
    new Uint8Array([1, 2]),
  ];
  const prefixes = [["t", ns, "u"], ["t", ns, "n"], ["t", ns, "c"]];
  const key = (): KvKeyJSON =>
    keyToJSON([...pick(prefixes), ...Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(parts))] as Deno.KvKey);
  const counterKey = (): KvKeyJSON => keyToJSON(["t", ns, "c", pick(["x", "y", "z"])]);
  const value = (): KvValueJSON =>
    valueToJSON(pick<unknown>([
      "s" + Math.floor(r() * 100),
      Math.floor(r() * 1000) / 7,
      BigInt(Math.floor(r() * 1e6)) * 1000003n,
      r() < 0.5,
      null,
      { a: 1, nested: { b: [1, "two", 3n] } },
      [1, 2, 3],
      new Uint8Array([1, 2, 3, 0]),
      new Date(1_760_000_000_000 + Math.floor(r() * 1e9)),
      new Map([["k", 1]]),
      new Set(["x", "y"]),
      new Deno.KvU64(BigInt(Math.floor(r() * 1000))),
    ]));
  const u64 = () => valueToJSON(new Deno.KvU64(BigInt(Math.floor(r() * 50))));
  const selector = () => {
    const p = pick(prefixes);
    const c = r();
    if (c < 0.55) return { prefix: keyToJSON(p as Deno.KvKey) };
    if (c < 0.7) return { prefix: keyToJSON(p as Deno.KvKey), start: keyToJSON([...p, pick(parts)] as Deno.KvKey) };
    if (c < 0.85) return { prefix: keyToJSON(p as Deno.KvKey), end: keyToJSON([...p, pick(parts)] as Deno.KvKey) };
    if (c < 0.95) {
      return { start: keyToJSON([...p, pick(parts)] as Deno.KvKey), end: keyToJSON([...pick(prefixes), pick(parts)] as Deno.KvKey) };
    }
    return { prefix: keyToJSON(p as Deno.KvKey), start: keyToJSON(["elsewhere"]) }; // invalid: start outside prefix
  };
  const ops: Op[] = [];
  let slot = 0;
  for (let i = 0; i < n; i++) {
    const c = r();
    if (c < 0.22) ops.push({ op: "set", key: key(), value: value() });
    else if (c < 0.3) ops.push({ op: "delete", key: key() });
    else if (c < 0.42) ops.push({ op: "get", key: r() < 0.3 ? counterKey() : key(), slot: `s${slot++}` });
    else if (c < 0.47) ops.push({ op: "getMany", keys: [key(), key(), counterKey()] });
    else if (c < 0.62) {
      const sel = selector();
      const limit = r() < 0.6 ? 1 + Math.floor(r() * 5) : undefined;
      const reverse = r() < 0.4;
      const save = `cur${i}`;
      ops.push({ op: "list", selector: sel, limit, reverse, batchSize: 1 + Math.floor(r() * 3), saveCursor: save });
      if (limit && r() < 0.7) ops.push({ op: "list", selector: sel, limit: 3, reverse, cursorSlot: save });
    } else {
      const checks = Array.from(
        { length: Math.floor(r() * 3) },
        () => r() < 0.3 || slot === 0 ? { key: key(), slot: null } : { key: key(), slot: `s${Math.floor(r() * slot)}` },
      );
      // also check the exact key a slot was read from, so successful checks happen too
      if (slot > 0 && r() < 0.6) {
        const s = Math.floor(r() * slot);
        const getOp = ops.find((o) => o.op === "get" && o.slot === `s${s}`) as { key: KvKeyJSON } | undefined;
        if (getOp) checks.push({ key: getOp.key, slot: `s${s}` });
      }
      const mutations = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
        const t = r();
        if (t < 0.4) return { type: "set" as const, key: key(), value: value() };
        if (t < 0.55) return { type: "delete" as const, key: key() };
        // sum/min/max mostly on counters; sometimes on a key holding a non-U64 value (an error in Deno)
        return { type: pick(["sum", "min", "max"] as const), key: r() < 0.85 ? counterKey() : key(), value: u64() };
      });
      ops.push({ op: "atomic", checks, mutations });
    }
  }
  return ops;
}

for (const seed of [11, 12, 13, 14]) {
  Deno.test(`random op program matches Deno KV (seed ${seed}, 250 ops)`, async () => {
    const ns = `p${seed}-${crypto.randomUUID().slice(0, 8)}`;
    const ops = program(seed, 250, ns);
    const kv = await Deno.openKv(":memory:");
    const a = await onDeno(kv, ops, {});
    kv.close();
    const b = await onWorker(ns, ops);
    const na = normalizeStamps(a) as unknown[], nb = normalizeStamps(b) as unknown[];
    for (let i = 0; i < ops.length; i++) {
      assertEquals(nb[i], na[i], `op ${i} ${JSON.stringify(ops[i])}`);
    }
    // the program exercised what it should
    const flat = JSON.stringify(a);
    assert(flat.includes('"ok":false'), "some atomic check failed");
    assert(/"ok":true,"versionstamp"/.test(flat), "some commit succeeded");
    assert(flat.includes("non-U64"), "a sum/min/max hit a non-U64 value");
    assert(flat.includes("not in the keyspace"), "an invalid selector was rejected");
  });
}

Deno.test("20 concurrent check-guarded commits: exactly one wins, as on Deno", async () => {
  const ns = `race-${crypto.randomUUID().slice(0, 8)}`;
  const k = keyToJSON(["race", ns]);
  const setup: Op[] = [{ op: "set", key: k, value: valueToJSON("fresh") }, { op: "get", key: k, slot: "v" }];
  const race: Op = { op: "atomic", checks: [{ key: k, slot: "v" }], mutations: [{ type: "set", key: k, value: valueToJSON("burned") }] };
  const kv = await Deno.openKv(":memory:");
  const slots: Slots = {};
  await onDeno(kv, setup, slots);
  const denoWins =
    (await Promise.all(Array.from({ length: 20 }, () => runOp(kv, race, slots)))).filter((x) => (x as { ok: boolean }).ok).length;
  kv.close();
  await onWorker(ns, setup);
  const workerWins =
    (await Promise.all(Array.from({ length: 20 }, () => onWorker(ns, [race])))).filter((x) => (x[0] as { ok: boolean }).ok).length;
  assertEquals([denoWins, workerWins], [1, 1]);
});

Deno.test("expireIn: hidden right after expiry, removed by the alarm; matches Deno after its sweep", async () => {
  const ns = `ttl-${crypto.randomUUID().slice(0, 8)}`;
  const tk = keyToJSON(["ttl", ns, "short"]), pk = keyToJSON(["ttl", ns, "permanent"]);
  const write: Op[] = [
    { op: "set", key: tk, value: valueToJSON("bye"), expireIn: 1500 },
    { op: "set", key: pk, value: valueToJSON("stay") },
  ];
  const read: Op[] = [
    { op: "get", key: tk },
    { op: "list", selector: { prefix: keyToJSON(["ttl", ns]) } },
    {
      op: "atomic",
      checks: [{ key: tk, slot: null }],
      mutations: [{ type: "set", key: keyToJSON(["ttl", ns, "after"]), value: valueToJSON(1) }],
    },
  ];
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(`${dir}/kv.sqlite`);
  await onDeno(kv, write, {});
  await onWorker(ns, write);
  const before = await onWorker(ns, [{ op: "get", key: tk }]);
  assertEquals((before[0] as { value: unknown }).value, valueToJSON("bye"));

  await new Promise((r) => setTimeout(r, 2500));
  const port = normalizeStamps(await onWorker(ns, read)) as { value: unknown }[];
  assertEquals(port[0].value, null, "port hides an expired key immediately");

  // Deno may keep serving an expired key until its background sweep; wait for it, then compare.
  const deadline = Date.now() + 90_000;
  while ((await kv.get(["ttl", ns, "short"])).value !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
  const deno = normalizeStamps(await onDeno(kv, read, {})) as unknown[];
  kv.close();
  assertEquals(port, deno);
  await Deno.remove(dir, { recursive: true });

  // the alarm deleted the expired row from the Durable Object's SQLite file
  const stateDir = Deno.env.get("TEST_WORKER_STATE");
  if (stateDir) {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of Deno.readDirSync(d)) {
        e.isDirectory ? walk(`${d}/${e.name}`) : e.name.endsWith(".sqlite") && files.push(`${d}/${e.name}`);
      }
    };
    walk(stateDir);
    let expiredRows = 0, liveRows = 0;
    for (const f of files) {
      const db = new DatabaseSync(f, { readOnly: true });
      try {
        expiredRows += (db.prepare("SELECT count(*) AS n FROM kv WHERE exp IS NOT NULL AND exp <= ?").get(Date.now()) as { n: number }).n;
        liveRows += (db.prepare("SELECT count(*) AS n FROM kv").get() as { n: number }).n;
      } catch {
        /* not a DenoKvObject database */
      } finally {
        db.close();
      }
    }
    assert(liveRows > 0, "found the Durable Object database");
    assertEquals(expiredRows, 0, "expired rows were deleted by the alarm");
  }
});

Deno.test("export -> import keeps keys, values, versionstamps and exact expiry; new writes sort after", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/src.sqlite`;
  const ns = `imp-${crypto.randomUUID().slice(0, 8)}`;
  const kv = await Deno.openKv(path);
  for (let i = 0; i < 300; i++) await kv.set(["imp", ns, "item", i], { i, tags: new Set(["a"]), when: new Date(i * 1000) });
  await kv.set(["imp", ns, "session", "s1"], "token", { expireIn: 3_600_000 });
  await kv.set(["imp", ns, "counter"], new Deno.KvU64(42n));
  const expected: string[] = [];
  for await (const e of kv.list({ prefix: ["imp", ns] })) {
    expected.push(JSON.stringify([keyToJSON(e.key), valueToJSON(e.value), e.versionstamp]));
  }
  kv.close();

  const deno = Deno.execPath();
  const exp = new Deno.Command(deno, {
    args: ["run", "--unstable-kv", "-A", "tools/export.ts", path, "--out", `${dir}/export.ndjson`],
    stderr: "piped",
  });
  const eo = await exp.output();
  assert(eo.success, new TextDecoder().decode(eo.stderr));
  const exported = (await Deno.readTextFile(`${dir}/export.ndjson`)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sess = exported.find((e) => JSON.stringify(e.key).includes("s1"));
  assert(sess.expireAt > Date.now() + 3_500_000, "export carries the exact expiry");

  const imp = new Deno.Command(deno, {
    args: ["run", "-A", "tools/import.ts", "--url", WORKER, "--in", `${dir}/export.ndjson`, "--batch-bytes", "20000"],
    env: { KV_MIGRATION_TOKEN: TOKEN },
    stderr: "piped",
  });
  const io = await imp.output();
  const log = new TextDecoder().decode(io.stderr);
  assert(io.success, log);
  assert(/imported 302 entries in [2-9]\d* batch/.test(log), log);

  const listed = await onWorker(ns, [{ op: "list", selector: { prefix: keyToJSON(["imp", ns]) } }]) as {
    entries: { key: unknown; value: unknown; versionstamp: string }[];
  }[];
  assertEquals(listed[0].entries.map((e) => JSON.stringify([e.key, e.value, e.versionstamp])), expected);

  const res = await fetch(`${WORKER}/__kv/export?limit=5000`, { headers: { "x-kv-migration-token": TOKEN } });
  const back = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assertEquals(back.find((e) => JSON.stringify(e.key).includes("s1")).expireAt, sess.expireAt);

  const maxImported = exported.map((e) => e.versionstamp).sort().at(-1);
  const after = await onWorker(ns, [{ op: "set", key: keyToJSON(["imp", ns, "new"]), value: valueToJSON(1) }]) as {
    versionstamp: string;
  }[];
  assert(after[0].versionstamp > maxImported, `${after[0].versionstamp} > ${maxImported}`);

  const denied = await fetch(`${WORKER}/__kv/export`, { headers: { "x-kv-migration-token": "wrong" } });
  await denied.body?.cancel();
  assertEquals(denied.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("TTL policy gives exported-without-expiry keys an expiry from import time", async () => {
  const { applyPolicy } = await import("../tools/import.ts");
  const now = 1_000_000;
  const entries = [
    { key: keyToJSON(["rl", "1.2.3.4"]), value: valueToJSON(1), versionstamp: "00000000000000010000" },
    { key: keyToJSON(["rl"]), value: valueToJSON(1), versionstamp: "00000000000000010000" },
    { key: keyToJSON(["rlx", "a"]), value: valueToJSON(1), versionstamp: "00000000000000010000" },
    { key: keyToJSON(["daily", "s", "2026-10-11"]), value: valueToJSON(1), versionstamp: "00000000000000010000" },
    { key: keyToJSON(["daily", "s", "x"]), value: valueToJSON(1), versionstamp: "00000000000000010000", expireAt: 5 },
  ] as { key: unknown[]; value: unknown; versionstamp: string; expireAt?: number }[];
  const report = applyPolicy(entries, [{ prefix: ["rl"], expireIn: 3_600_000 }, { prefix: ["daily"], expireIn: 1000 }, {
    prefix: ["daily", "s"],
    expireIn: 2000,
  }], now);
  assertEquals(entries.map((e) => e.expireAt ?? null), [now + 3_600_000, null, null, now + 2000, 5]);
  assertEquals(report.exact, 1);
});
