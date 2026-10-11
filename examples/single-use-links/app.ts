// A small single-use link app written against the Deno KV API. The same handler runs on
// Deno (deno.ts) and on Workers through deno-kv-workers (worker.ts).
type Kv = Deno.Kv;

const id = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

export async function handle(req: Request, kv: Kv): Promise<Response> {
  const url = new URL(req.url);
  const [, a, b] = url.pathname.split("/");
  if (req.method === "POST" && a === "links") {
    const { target, ttlMs } = await req.json() as { target: string; ttlMs?: number };
    const link = { id: id(), target, used: false, created: new Date().toISOString() };
    await kv.atomic()
      .check({ key: ["links", link.id], versionstamp: null })
      .set(["links", link.id], link, ttlMs ? { expireIn: ttlMs } : undefined)
      .sum(["stats", "created"], 1n)
      .commit();
    return Response.json(link, { status: 201 });
  }
  if (req.method === "GET" && a === "r" && b) {
    // Burn the link exactly once: the check fails for every concurrent loser.
    const entry = await kv.get<{ target: string; used: boolean }>(["links", b]);
    if (!entry.value || entry.value.used) return new Response("gone", { status: 410 });
    const res = await kv.atomic()
      .check(entry)
      .set(["links", b], { ...entry.value, used: true })
      .sum(["stats", "redeemed"], 1n)
      .commit();
    if (!res.ok) return new Response("gone", { status: 410 });
    return new Response(null, { status: 303, headers: { location: entry.value.target } });
  }
  if (req.method === "DELETE" && a === "links" && b) {
    await kv.delete(["links", b]);
    return new Response(null, { status: 204 });
  }
  if (req.method === "GET" && a === "links") {
    const it = kv.list<{ id: string }>({ prefix: ["links"] }, {
      limit: Number(url.searchParams.get("limit") ?? 50),
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    const items = [];
    for await (const e of it) items.push(e.value.id);
    return Response.json({ items, cursor: it.cursor });
  }
  if (req.method === "GET" && a === "stats") {
    const [c, r] = await kv.getMany<[Deno.KvU64, Deno.KvU64]>([["stats", "created"], ["stats", "redeemed"]]);
    return Response.json({ created: Number(c.value?.value ?? 0n), redeemed: Number(r.value?.value ?? 0n) });
  }
  return new Response("not found", { status: 404 });
}
