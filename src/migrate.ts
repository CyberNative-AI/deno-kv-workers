// Token-guarded migration endpoints for a Worker that uses DenoKvObject:
//   POST /__kv/import   body: @deno/kv-utils NDJSON lines, each optionally with "expireAt" (ms epoch)
//   GET  /__kv/export?after=<hex>&limit=<n>   NDJSON of live entries in key order (+ "expireAt")
// Both answer 404 unless the token variable is set and the x-kv-migration-token header matches.
// Remove the token (or this route) once the migration is verified.
import type { ImportEntry } from "./object.ts";

export type MigrationOptions = { binding?: string; name?: string; tokenVar?: string; maxBatch?: number };

type Stub = {
  importEntries(e: ImportEntry[]): Promise<unknown>;
  exportEntries(o: { after?: string; limit?: number }): Promise<(ImportEntry & { k: string })[]>;
};

async function sameToken(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

export async function handleMigration(req: Request, env: Record<string, unknown>, opts: MigrationOptions = {}): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/__kv/")) return null;
  const token = env[opts.tokenVar ?? "KV_MIGRATION_TOKEN"];
  const given = req.headers.get("x-kv-migration-token");
  if (typeof token !== "string" || !token || !given || !(await sameToken(token, given))) {
    return new Response("Not Found", { status: 404 });
  }
  const ns = env[opts.binding ?? "DENO_KV"] as { idFromName(n: string): unknown; get(id: unknown): Stub };
  const stub = ns.get(ns.idFromName(opts.name ?? "default"));
  if (url.pathname === "/__kv/import" && req.method === "POST") {
    const entries = (await req.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ImportEntry);
    if (entries.length > (opts.maxBatch ?? 5000)) return new Response("batch too large", { status: 413 });
    return Response.json(await stub.importEntries(entries));
  }
  if (url.pathname === "/__kv/export" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 5000);
    const rows = await stub.exportEntries({ after: url.searchParams.get("after") ?? "", limit });
    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (rows.length === limit) headers["x-kv-next-after"] = rows[rows.length - 1].k;
    const body = rows.map(({ k: _k, ...e }) => JSON.stringify(e) + "\n").join("");
    return new Response(body, { headers });
  }
  return new Response("Not Found", { status: 404 });
}
