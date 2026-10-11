// End-to-end check of tools/verify.ts on the example app: the same request script runs against
// the app on real Deno KV and on Workers. The Durable Object port must produce no differences;
// the negative control (atomic checks dropped, as in a get-then-put Workers KV port) must be flagged.
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";

const deno = Deno.execPath();
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;
const TOKEN = "local-test-token";

async function waitFor(url: string, child: Deno.ChildProcess) {
  for (let i = 0; i < 90; i++) {
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
      procs.push(runDeno(`${dir}/a1.sqlite`, 8810), startWorker("../examples/single-use-links/", 8811, `${dir}/port`));
      await waitFor("http://127.0.0.1:8810/stats", procs[0]);
      await waitFor("http://127.0.0.1:8811/stats", procs[1]);
      // verify reads the Deno store's SQLite file next to the running app (SQLite allows a second reader).
      const good = await verify("http://127.0.0.1:8810", "http://127.0.0.1:8811", `${dir}/a1.sqlite`);
      assertEquals(good.code, 0, good.out);
      assert(good.out.includes("responses: 9/9 steps identical"), good.out);
      assert(/state: (\d+) vs \1 entries; 0 differing/.test(good.out), good.out);

      procs.push(runDeno(`${dir}/a2.sqlite`, 8812), startWorker("../test/naive-worker/", 8813, `${dir}/naive`));
      await waitFor("http://127.0.0.1:8812/stats", procs[2]);
      await waitFor("http://127.0.0.1:8813/stats", procs[3]);
      const bad = await verify("http://127.0.0.1:8812", "http://127.0.0.1:8813", `${dir}/a2.sqlite`);
      assertEquals(bad.code, 1, bad.out);
      assert(bad.out.includes("DIFF 20 concurrent redeems of link 1"), bad.out);
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
