// tools/import.ts batching and failure messages, against a stub server (no Worker needed).
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";

const deno = Deno.execPath();

async function ndjson(n: number): Promise<string> {
  const dir = await Deno.makeTempDir();
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      key: [{ type: "string", value: "k" }, { type: "number", value: String(i) }],
      value: { type: "string", value: "v" + i },
      versionstamp: (i + 1).toString(16).padStart(20, "0"),
    }));
  await Deno.writeTextFile(`${dir}/in.ndjson`, lines.join("\n") + "\n");
  return `${dir}/in.ndjson`;
}

// Serves /__kv/import, records each batch's entry count; `fail` answers one batch with an error.
function stub(fail?: { batch: number; status: number; body: string }) {
  const sizes: number[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const n = (await req.text()).split("\n").filter(Boolean).length;
    sizes.push(n);
    if (fail && sizes.length === fail.batch) return new Response(fail.body, { status: fail.status });
    return Response.json({ imported: n, skippedExpired: 0 });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, sizes, close: () => server.shutdown() };
}

async function runImport(url: string, input: string, ...extra: string[]) {
  const o = await new Deno.Command(deno, {
    args: ["run", "-A", "tools/import.ts", "--url", url, "--in", input, ...extra],
    env: { KV_MIGRATION_TOKEN: "t" },
    stderr: "piped",
  }).output();
  return { code: o.code, log: new TextDecoder().decode(o.stderr) };
}

Deno.test("--batch-entries caps entries per batch", async () => {
  const input = await ndjson(302);
  const s = stub();
  const r = await runImport(s.url, input, "--batch-entries", "50");
  await s.close();
  assertEquals(r.code, 0, r.log);
  assertEquals(s.sizes, [50, 50, 50, 50, 50, 50, 2]);
  assert(/imported 302 entries in 7 batch/.test(r.log), r.log);
});

Deno.test("a 5xx batch failure (Free-plan CPU limit) names --batch-entries; a 4xx does not", async () => {
  const input = await ndjson(30);
  let s = stub({ batch: 2, status: 503, body: "<html>Error 1102 Worker exceeded resource limits</html>" });
  let r = await runImport(s.url, input, "--batch-entries", "10");
  await s.close();
  assertEquals(r.code, 1, r.log);
  assert(/batch 2\/3 failed: HTTP 503/.test(r.log), r.log);
  assert(/1 batch\(es\) before it were imported/.test(r.log), r.log);
  assert(/--batch-entries 100/.test(r.log), r.log);

  s = stub({ batch: 1, status: 404, body: "Not Found" });
  r = await runImport(s.url, input);
  await s.close();
  assertEquals(r.code, 1, r.log);
  assert(/batch 1\/1 failed: HTTP 404 Not Found/.test(r.log), r.log);
  assert(!/--batch-entries/.test(r.log), r.log);
});

Deno.test("invalid batch sizes are refused before anything is sent", async () => {
  const input = await ndjson(3);
  const s = stub();
  for (const bad of [["--batch-entries", "0"], ["--batch-entries", "5001"], ["--batch-entries", "x"], ["--batch-bytes", "-1"]]) {
    const r = await runImport(s.url, input, ...bad);
    assertEquals(r.code, 2, `${bad.join(" ")}: ${r.log}`);
  }
  await s.close();
  assertEquals(s.sizes, []);
});
