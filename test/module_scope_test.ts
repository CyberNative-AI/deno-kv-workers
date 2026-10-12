// README step 2: a module-level `const kv = await Deno.openKv()` from a Deno Deploy app can stay
// when the shim is used. The test Worker opens one handle at module scope and serves every request with it.
import { deepStrictEqual as assertEquals } from "node:assert";

const WORKER = Deno.env.get("TEST_WORKER_URL") ?? "http://127.0.0.1:8799";

async function call(body: Record<string, unknown>, claimant = ""): Promise<{ ok: boolean; n?: number }> {
  const res = await fetch(`${WORKER}/__test/module-kv`, {
    method: "POST",
    headers: { "x-claimant": claimant },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return await res.json();
}

Deno.test("module-level Deno.openKv() handle works across requests", async () => {
  const run = crypto.randomUUID();
  for (let i = 1; i <= 3; i++) assertEquals(await call({ run, op: "inc" }), { ok: true, n: i });
  for (const id of ["a", "b"]) {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call({ run, op: "claim", id }, String(i))));
    assertEquals(results.filter((r) => r.ok).length, 1, `claim ${id}: exactly one of 20 concurrent claims wins`);
  }
});
