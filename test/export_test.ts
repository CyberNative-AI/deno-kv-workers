// Export consistency: Deno KV has no snapshot read, so tools/export.ts lists the store twice and refuses
// an export that a concurrent commit could have split. Local SQLite stores only (no Worker needed).
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";

const ACCOUNTS = 200, START = 100;

async function seed(path: string) {
  const kv = await Deno.openKv(path);
  let op = kv.atomic();
  for (let i = 0; i < ACCOUNTS; i++) op.set(["acct", i], START);
  await op.commit();
  for (let b = 0; b < 3000; b += 500) {
    op = kv.atomic();
    for (let i = b; i < b + 500; i++) op.set(["filler", i], "f" + i);
    await op.commit();
  }
  kv.close();
}

// Atomic transfers from late-sorting to early-sorting accounts until stopped: every committed state
// has the same total, but a paged read taken during the transfers can miss or double a unit.
function transfers(path: string) {
  let stop = false, commits = 0;
  const done = (async () => {
    const kv = await Deno.openKv(path);
    while (!stop) {
      const a = ACCOUNTS - 1 - (commits % 20), b = commits % 20;
      const [ea, eb] = await kv.getMany<number[]>([["acct", a], ["acct", b]]);
      // The export's own reader can briefly lock the file under load; a failed commit changes nothing.
      const r = await kv.atomic().check(ea, eb).set(["acct", a], ea.value! - 1).set(["acct", b], eb.value! + 1).commit()
        .catch((e) => {
          if (!/database is locked/.test(String(e))) throw e;
          return { ok: false };
        });
      if (r.ok) commits++;
    }
    kv.close();
  })();
  return { stop: async () => (stop = true, await done, commits) };
}

async function exportTo(path: string, out: string, ...extra: string[]) {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-kv", "-A", "tools/export.ts", path, "--out", out, ...extra],
    stderr: "piped",
  }).output();
  return { code: o.code, log: new TextDecoder().decode(o.stderr) };
}

async function exists(p: string) {
  return await Deno.stat(p).then(() => true, () => false);
}

Deno.test("export of a quiet store passes the recheck", async () => {
  const dir = await Deno.makeTempDir();
  await seed(`${dir}/kv.sqlite`);
  const r = await exportTo(`${dir}/kv.sqlite`, `${dir}/out.ndjson`);
  assertEquals(r.code, 0, r.log);
  assert(/exported 3200 entries; .*recheck: unchanged/.test(r.log), r.log);
  let total = 0;
  for (const l of (await Deno.readTextFile(`${dir}/out.ndjson`)).split("\n").filter(Boolean)) {
    const e = JSON.parse(l);
    if (e.key[0].value === "acct") total += e.value.value;
  }
  assertEquals(total, ACCOUNTS * START);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("export taken during writes is refused (exit 3) and its file deleted", async () => {
  const dir = await Deno.makeTempDir();
  await seed(`${dir}/kv.sqlite`);
  const w = transfers(`${dir}/kv.sqlite`);
  const r = await exportTo(`${dir}/kv.sqlite`, `${dir}/out.ndjson`);
  const commits = await w.stop();
  assert(commits > 0, "the writer committed during the export");
  assertEquals(r.code, 3, r.log);
  assert(/export NOT consistent/.test(r.log) && /Stop writes/.test(r.log), r.log);
  assertEquals(await exists(`${dir}/out.ndjson`), false, "an inconsistent export is not left behind");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("--no-recheck skips the second pass", async () => {
  const dir = await Deno.makeTempDir();
  await seed(`${dir}/kv.sqlite`);
  const w = transfers(`${dir}/kv.sqlite`);
  const r = await exportTo(`${dir}/kv.sqlite`, `${dir}/out.ndjson`, "--no-recheck");
  await w.stop();
  assertEquals(r.code, 0, r.log);
  assert(/recheck skipped/.test(r.log), r.log);
  await Deno.remove(dir, { recursive: true });
});

// Expiry is read from the SQLite file, not from kv.list. A key written with a TTL after the expiry map was
// read but before pass 1 lists it has the same versionstamp in both passes, so only the expiry tells.
const SESSIONS: Deno.KvKey[] = [0, 1.5, -2, 3n, "s", true, false, new Uint8Array([4, 0, 5])].map((p) => ["session", p]);

async function exportDuringTtlWrite(rewrite: boolean) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/kv.sqlite`, out = `${dir}/out.ndjson`;
  const kv = await Deno.openKv(path);
  for (let b = 0; b < 20000; b += 500) {
    const op = kv.atomic();
    for (let i = b; i < b + 500; i++) op.set(["filler", i], "f" + i);
    await op.commit();
  }
  if (rewrite) {
    const op = kv.atomic();
    for (const k of SESSIONS) op.set(k, "old", { expireIn: 600_000 });
    await op.commit();
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-kv", "-A", "tools/export.ts", path, "--out", out],
    stderr: "piped",
  }).spawn();
  // Pass 1 has begun writing lines, so the expiry map is read; the session keys sort after all filler keys.
  while (!((await Deno.stat(out).catch(() => null))?.size)) await new Promise((r) => setTimeout(r, 2));
  const op = kv.atomic();
  for (const k of SESSIONS) op.set(k, "new", { expireIn: 3_600_000 });
  await op.commit();
  const written = Date.now();
  const o = await child.output();
  const r = { code: o.code, log: new TextDecoder().decode(o.stderr) };
  assertEquals(r.code, 3, r.log);
  assert(/export NOT consistent/.test(r.log), r.log);
  assertEquals(await exists(out), false, "an export with a stale or missing expiry is not left behind");

  // Writes stopped: the rerun passes and every session key carries its new expiry.
  const again = await exportTo(path, out);
  assertEquals(again.code, 0, again.log);
  const sess = (await Deno.readTextFile(out)).split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.key[0].value === "session");
  assertEquals(sess.length, SESSIONS.length);
  for (const e of sess) {
    assert(e.expireAt > written + 3_000_000 && e.expireAt <= written + 3_600_000, JSON.stringify(e));
  }
  kv.close();
  await Deno.remove(dir, { recursive: true });
}

Deno.test("TTL keys written during the export are refused (exit 3), not exported without expiry", async () => {
  await exportDuringTtlWrite(false);
});

Deno.test("TTL keys re-written during the export are refused (exit 3), not exported with the old expiry", async () => {
  await exportDuringTtlWrite(true);
});
