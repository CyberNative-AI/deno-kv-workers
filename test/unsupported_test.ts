// Deno KV features with no faithful Workers equivalent fail loudly instead of silently.
import { deepStrictEqual as assertEquals } from "node:assert";

const WORKER = Deno.env.get("TEST_WORKER_URL") ?? "http://127.0.0.1:8799";

Deno.test("watch and queues throw explicit errors on Workers", async () => {
  const r = await (await fetch(`${WORKER}/__test/unsupported`)).json() as Record<string, string>;
  assertEquals(Object.keys(r).sort(), ["atomic.enqueue", "enqueue", "listenQueue", "watch"]);
  for (const [m, msg] of Object.entries(r)) {
    assertEquals(/is not supported on Cloudflare Workers by deno-kv-workers; use /.test(msg), true, `${m}: ${msg}`);
  }
});
