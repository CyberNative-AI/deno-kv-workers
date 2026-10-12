// End-to-end check of tools/verify.ts on the example app: the same request script runs against
// the app on real Deno KV and on Workers. The Durable Object port must produce no differences;
// the negative control (atomic checks dropped, as in a get-then-put Workers KV port) must be flagged.
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";

const deno = Deno.execPath();
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;
const TOKEN = "local-test-token";

// A free port from the OS, so parallel runs never meet on a fixed port.
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

async function waitFor(url: string, child: Deno.ChildProcess) {
  let exited = false;
  child.status.then(() => (exited = true));
  for (let i = 0; i < 90; i++) {
    // a server that lost its port exits; never accept another process answering there
    if (exited) throw new Error(`${url}: server exited before it answered`);
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`${url} did not start`);
}

function startWorker(dir: string, port: number, state: string): Deno.ChildProcess {
  return new Deno.Command(wrangler, {
    args: [
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      state,
      "--var",
      `KV_MIGRATION_TOKEN:${TOKEN}`,
      "--show-interactive-dev-session=false",
    ],
    cwd: new URL(dir, import.meta.url).pathname,
    stdout: "null",
    stderr: "null",
  }).spawn();
}

async function verify(a: string, b: string, stateA: string): Promise<{ code: number; out: string }> {
  const o = await new Deno.Command(deno, {
    args: [
      "run",
      "--unstable-kv",
      "-A",
      "tools/verify.ts",
      "examples/single-use-links/script.json",
      "--a",
      a,
      "--b",
      b,
      "--state-a-kv",
      stateA,
      "--state-b",
      "worker",
    ],
    env: { KV_MIGRATION_TOKEN: TOKEN },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: o.code, out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) };
}

Deno.test({
  name: "verify: example app on the Durable Object port matches Deno; a check-dropping port is flagged",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const procs: Deno.ChildProcess[] = [];
    const runDeno = (kvPath: string, port: number) =>
      new Deno.Command(deno, {
        args: ["run", "--unstable-kv", "-A", "examples/single-use-links/deno.ts", kvPath, String(port)],
        stdout: "null",
        stderr: "null",
      }).spawn();
    try {
      // Each comparison needs a fresh original, because the script mutates it.
      const [a1, b1, a2, b2] = [freePort(), freePort(), freePort(), freePort()];
      procs.push(runDeno(`${dir}/a1.sqlite`, a1), startWorker("../examples/single-use-links/", b1, `${dir}/port`));
      await waitFor(`http://127.0.0.1:${a1}/stats`, procs[0]);
      await waitFor(`http://127.0.0.1:${b1}/stats`, procs[1]);
      // verify reads the Deno store's SQLite file next to the running app (SQLite allows a second reader).
      const good = await verify(`http://127.0.0.1:${a1}`, `http://127.0.0.1:${b1}`, `${dir}/a1.sqlite`);
      assertEquals(good.code, 0, good.out);
      assert(good.out.includes("responses: 22/22 steps identical"), good.out);
      assert(/state: (\d+) vs \1 entries; 0 differing/.test(good.out), good.out);
      assert(good.out.includes("note: 8 concurrent steps are samples"), good.out);

      // The script races several fresh links: one race alone can happen to serialize and show a single winner.
      procs.push(runDeno(`${dir}/a2.sqlite`, a2), startWorker("../test/naive-worker/", b2, `${dir}/naive`));
      await waitFor(`http://127.0.0.1:${a2}/stats`, procs[2]);
      await waitFor(`http://127.0.0.1:${b2}/stats`, procs[3]);
      const bad = await verify(`http://127.0.0.1:${a2}`, `http://127.0.0.1:${b2}`, `${dir}/a2.sqlite`);
      assertEquals(bad.code, 1, bad.out);
      assert(/DIFF 20 concurrent redeems of link \d+\n/.test(bad.out), bad.out);
      assert(bad.out.includes("DIFF stats"), bad.out);
      assert(bad.out.includes("RESULT: differences found"), bad.out);
    } finally {
      for (const p of procs) {
        try {
          p.kill();
          await p.status;
        } catch { /* already exited */ }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
