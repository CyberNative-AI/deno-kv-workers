// Export consistency: Deno KV has no snapshot read, so tools/export.ts lists the store twice and refuses
// an export that a concurrent commit could have split. Local SQLite stores only (no Worker needed).
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import { createHash } from "node:crypto";

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
      // A second process that opens the file with Deno.openKv (as the export does) can make this commit
      // fail with "database is locked"; a failed commit changes nothing.
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

// The export writes a temporary sibling of --out and renames it when done.
async function partials(out: string) {
  const dir = out.slice(0, out.lastIndexOf("/")), base = out.slice(out.lastIndexOf("/") + 1);
  const found: string[] = [];
  for await (const f of Deno.readDir(dir)) if (f.name.startsWith(base + ".") && f.name.endsWith(".partial")) found.push(f.name);
  return found;
}

// Resolves once pass 1 has written its first line, to --out or to a temporary file next to it.
async function firstLineWritten(out: string, before = 0) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (((await Deno.stat(out).catch(() => null))?.size ?? before) !== before) return;
    for (const p of await partials(out)) {
      if ((await Deno.stat(out.slice(0, out.lastIndexOf("/") + 1) + p).catch(() => null))?.size) return;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
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

Deno.test("export taken during writes is refused (exit 3) and no file written", async () => {
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
  await firstLineWritten(out);
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

// A failed, refused or interrupted rerun must not cost the user an earlier good export.
Deno.test("a failed, refused or interrupted rerun leaves the earlier export at --out as it was", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/kv.sqlite`, out = `${dir}/out.ndjson`;
  await seed(path);
  const good = await exportTo(path, out);
  assertEquals(good.code, 0, good.log);
  const before = await Deno.readFile(out);
  // Compare digests: a failed deepStrictEqual on the file bytes builds a diff whose size grows with the square of the file.
  const id = (b: Uint8Array) => `${b.length} bytes, sha256 ${createHash("sha256").update(b).digest("hex")}`;
  const intact = async (what: string) => {
    assertEquals(id(await Deno.readFile(out)), id(before), `${what}: --out changed`);
    assertEquals(await partials(out), [], `${what}: temporary file left behind`);
  };

  const badPath = await exportTo(`${dir}/missing.sqlite`, out);
  assert(badPath.code !== 0, badPath.log);
  await intact("bad source path");

  // KV Connect: /bad/ rejects the token; /flaky/ accepts it, then fails the first read, after the source is open.
  const ac = new AbortController();
  const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} }, (req) => {
    if (new URL(req.url).pathname !== "/flaky/") return new Response("invalid token", { status: 401 });
    return Response.json({
      version: 3,
      databaseId: crypto.randomUUID(),
      token: "t",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      endpoints: [{ url: `http://127.0.0.1:${server.addr.port}/data`, consistency: "strong" }],
    });
  });
  for (const [path, what] of [["bad/", "rejected token"], ["flaky/", "read failed after the source was opened"]]) {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--unstable-kv", "-A", "tools/export.ts", `http://127.0.0.1:${server.addr.port}/${path}`, "--out", out],
      env: { DENO_KV_ACCESS_TOKEN: "wrong" },
      stderr: "piped",
    }).output();
    assert(r.code !== 0, new TextDecoder().decode(r.stderr));
    await intact(what);
  }
  ac.abort();
  await server.finished;

  const w = transfers(path);
  const refused = await exportTo(path, out);
  await w.stop();
  assertEquals(refused.code, 3, refused.log);
  assert(/not written/.test(refused.log), refused.log);
  await intact("refused live export");

  for (let i = 0; i < 10; i++) { // a bigger store, so Ctrl-C lands during pass 1
    const kv = await Deno.openKv(path), op = kv.atomic();
    for (let j = 0; j < 200; j++) op.set(["big", i, j], "x".repeat(2000));
    await op.commit();
    kv.close();
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-kv", "-A", "tools/export.ts", path, "--out", out],
    stderr: "piped",
  }).spawn();
  await firstLineWritten(out, before.length);
  child.kill("SIGINT");
  const killed = await child.output();
  assertEquals(killed.code, 130, "Ctrl-C exit code");
  await intact("Ctrl-C");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("stdout needs --no-recheck (exit 2, nothing printed); with it the export streams", async () => {
  const dir = await Deno.makeTempDir();
  await seed(`${dir}/kv.sqlite`);
  const run = (...extra: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "--unstable-kv", "-A", "tools/export.ts", `${dir}/kv.sqlite`, ...extra],
      stdout: "piped",
      stderr: "piped",
    }).output();
  const refused = await run();
  const log = new TextDecoder().decode(refused.stderr);
  assertEquals(refused.code, 2, log);
  assertEquals(refused.stdout.length, 0, "nothing printed");
  assert(/--no-recheck/.test(log) && log.trim().split("\n").length === 1, log);
  const streamed = await run("--no-recheck");
  assertEquals(streamed.code, 0, new TextDecoder().decode(streamed.stderr));
  assertEquals(new TextDecoder().decode(streamed.stdout).split("\n").filter(Boolean).length, 3200);
  await Deno.remove(dir, { recursive: true });
});
