// Replay one request script against the original Deno app and against the Worker, then diff
// the responses and the stored KV state.
//
//   KV_MIGRATION_TOKEN=... deno run --unstable-kv -A tools/verify.ts script.json \
//       --a http://127.0.0.1:8000 --b http://127.0.0.1:8787 \
//       [--state-a deno-export.ndjson | --state-a-kv path/to/kv.sqlite] [--state-b worker] [--json report.json]
//
// --state-b worker reads the Worker's /__kv/export route (needs KV_MIGRATION_TOKEN).
// --state-a-kv reads a local Deno KV store directly (stop the Deno app first).
// Exit code: 0 when responses and state match after normalization, 1 when anything differs.
//
// Script format (see examples/single-use-links/script.json):
// {
//   "normalize": [{ "pattern": "[A-Za-z0-9]{8}", "replace": "<id>" }],   // applied to bodies and state values
//   "ignoreHeaders": [], "compareHeaders": ["location", "content-type"],
//   "steps": [
//     { "name": "create", "method": "POST", "path": "/links", "json": { "url": "https://example.com" },
//       "save": { "id": "id" } },                       // save top-level JSON field into {{id}}
//     { "name": "race", "method": "GET", "path": "/r/{{id}}", "concurrent": 20 },
//     { "sleep": 1000 }
//   ]
// }

type Step = {
  name?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  concurrent?: number;
  save?: Record<string, string>;
  sleep?: number;
};
type Script = { normalize?: { pattern: string; replace: string }[]; compareHeaders?: string[]; steps: Step[] };
type Observed = { name: string; responses: { status: number; headers: Record<string, string>; body: string }[] };

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

export function normalizer(script: Script) {
  const rules = (script.normalize ?? []).map((r) => [new RegExp(r.pattern, "g"), r.replace] as const);
  return (s: string) => rules.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

function fill(s: string, vars: Record<string, string>) {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

export async function replay(base: string, script: Script): Promise<Observed[]> {
  const vars: Record<string, string> = {};
  const norm = normalizer(script);
  const keep = (script.compareHeaders ?? ["location", "content-type"]).map((h) => h.toLowerCase());
  const out: Observed[] = [];
  for (const [i, step] of script.steps.entries()) {
    if (step.sleep) {
      await new Promise((r) => setTimeout(r, step.sleep));
      continue;
    }
    const once = async () => {
      const headers: Record<string, string> = { ...(step.headers ?? {}) };
      let body: string | undefined = step.body !== undefined ? fill(step.body, vars) : undefined;
      if (step.json !== undefined) {
        body = fill(JSON.stringify(step.json), vars);
        headers["content-type"] ??= "application/json";
      }
      const res = await fetch(new URL(fill(step.path ?? "/", vars), base), {
        method: step.method ?? "GET",
        headers,
        body,
        redirect: "manual",
      });
      const text = await res.text();
      return { res, text };
    };
    const n = step.concurrent ?? 1;
    const results = await Promise.all(Array.from({ length: n }, once));
    if (step.save) {
      const data = JSON.parse(results[0].text);
      for (const [v, field] of Object.entries(step.save)) vars[v] = String(data[field]);
    }
    const responses = results.map(({ res, text }) => ({
      status: res.status,
      headers: Object.fromEntries(keep.filter((h) => res.headers.has(h)).map((h) => [h, norm(fill(res.headers.get(h)!, {}))])),
      body: norm(text),
    }));
    // concurrent responses arrive in any order: compare them as a sorted multiset
    if (n > 1) responses.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out.push({ name: step.name ?? `step ${i + 1}`, responses });
  }
  return out;
}

type StateEntry = { key: unknown[]; value: unknown; versionstamp?: string; expireAt?: number };

export async function stateFromWorker(base: string, token: string): Promise<StateEntry[]> {
  const all: StateEntry[] = [];
  let after = "";
  for (;;) {
    const res = await fetch(new URL(`/__kv/export?limit=1000&after=${after}`, base), { headers: { "x-kv-migration-token": token } });
    if (!res.ok) throw new Error(`worker export failed: HTTP ${res.status}`);
    all.push(...(await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    const next = res.headers.get("x-kv-next-after");
    if (!next) return all;
    after = next;
  }
}

export async function stateFromDenoKv(path: string): Promise<StateEntry[]> {
  const { entryToJSON } = await import("../src/vendor/kv_json.ts");
  const kv = await Deno.openKv(path);
  const all: StateEntry[] = [];
  for await (const e of kv.list({ prefix: [] })) all.push(entryToJSON(e) as StateEntry);
  kv.close();
  return all;
}

// Keys often contain generated ids, so entries are compared as a multiset of normalized
// "key = value" lines rather than key by key.
export function diffState(a: StateEntry[], b: StateEntry[], norm: (s: string) => string) {
  const lines = (xs: StateEntry[]) => xs.map((e) => `${norm(JSON.stringify(e.key))} = ${norm(JSON.stringify(e.value))}`);
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const A = count(lines(a)), B = count(lines(b));
  const missing = (X: Map<string, number>, Y: Map<string, number>) =>
    [...X].flatMap(([l, n]) => Array(Math.max(0, n - (Y.get(l) ?? 0))).fill(l) as string[]);
  return { entriesA: a.length, entriesB: b.length, onlyA: missing(A, B), onlyB: missing(B, A) };
}

export function diffResponses(a: Observed[], b: Observed[]) {
  const diffs: { step: string; a: unknown; b: unknown }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      diffs.push({ step: a[i]?.name ?? b[i]?.name, a: a[i]?.responses, b: b[i]?.responses });
    }
  }
  return diffs;
}

if (import.meta.main) {
  const scriptPath = Deno.args.find((x, i) => !x.startsWith("--") && !Deno.args[i - 1]?.startsWith("--"));
  const A = arg("--a"), B = arg("--b");
  if (!scriptPath || !A || !B) {
    console.error(
      "usage: tools/verify.ts script.json --a DENO_URL --b WORKER_URL [--state-a FILE | --state-a-kv PATH] [--state-b worker|FILE] [--json OUT]",
    );
    Deno.exit(2);
  }
  const script = JSON.parse(await Deno.readTextFile(scriptPath)) as Script;
  const norm = normalizer(script);
  const ra = await replay(A, script);
  const rb = await replay(B, script);
  const responseDiffs = diffResponses(ra, rb);
  const steps = ra.length;
  console.log(`responses: ${steps - responseDiffs.length}/${steps} steps identical after normalization`);
  for (const d of responseDiffs) console.log(`  DIFF ${d.step}\n    a: ${JSON.stringify(d.a)}\n    b: ${JSON.stringify(d.b)}`);

  let state: ReturnType<typeof diffState> | null = null;
  const readFile = async (p: string) => (await Deno.readTextFile(p)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sa = arg("--state-a")
    ? await readFile(arg("--state-a")!)
    : arg("--state-a-kv")
    ? await stateFromDenoKv(arg("--state-a-kv")!)
    : null;
  const sbArg = arg("--state-b");
  const sb = sbArg === "worker" ? await stateFromWorker(B, Deno.env.get("KV_MIGRATION_TOKEN") ?? "") : sbArg ? await readFile(sbArg) : null;
  if (sa && sb) {
    state = diffState(sa, sb, norm);
    const n = state.onlyA.length + state.onlyB.length;
    console.log(`state: ${state.entriesA} vs ${state.entriesB} entries; ${n} differing entries`);
    for (const k of state.onlyA) console.log(`  only in a: ${k}`);
    for (const k of state.onlyB) console.log(`  only in b: ${k}`);
  } else console.log("state: not compared (pass --state-a/--state-a-kv and --state-b)");
  if (arg("--json")) {
    await Deno.writeTextFile(arg("--json")!, JSON.stringify({ responses: { a: ra, b: rb, diffs: responseDiffs }, state }, null, 2));
  }
  const clean = responseDiffs.length === 0 && (!state || state.onlyA.length + state.onlyB.length === 0);
  console.log(clean ? "RESULT: no differences" : "RESULT: differences found");
  Deno.exit(clean ? 0 : 1);
}
