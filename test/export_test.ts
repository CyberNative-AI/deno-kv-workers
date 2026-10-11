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
      if ((await kv.atomic().check(ea, eb).set(["acct", a], ea.value! - 1).set(["acct", b], eb.value! + 1).commit()).ok) {
        commits++;
      }
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
