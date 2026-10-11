// Test Worker: exposes the port through the same op interpreter the Deno side uses,
// plus the migration endpoints. Uses the Deno.openKv() shim, as a migrated app would.
import "../../src/shim.ts";
import { handleMigration } from "../../src/migrate.ts";
import { runOp, type Slots } from "../ops.ts";
export { DenoKvObject } from "../../src/object.ts";

const slots: Record<string, Slots> = {};

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    const migrated = await handleMigration(req, env);
    if (migrated) return migrated;
    const url = new URL(req.url);
    if (url.pathname === "/__test/ops" && req.method === "POST") {
      const { run, ops } = await req.json() as { run: string; ops: never[] };
      const kv = await (globalThis as unknown as { Deno: { openKv(): Promise<unknown> } }).Deno.openKv();
      const s = (slots[run] ??= {});
      const results = [];
      for (const op of ops) results.push(await runOp(kv, op, s));
      return Response.json(results);
    }
    if (url.pathname === "/__test/unsupported") {
      const kv = await (globalThis as unknown as { Deno: { openKv(): Promise<Record<string, () => unknown>> } }).Deno.openKv();
      const out: Record<string, string> = {};
      for (const m of ["watch", "enqueue", "listenQueue"]) {
        try {
          kv[m]();
          out[m] = "no error";
        } catch (e) {
          out[m] = (e as Error).message;
        }
      }
      try {
        (kv.atomic() as unknown as Record<string, () => unknown>).enqueue();
        out["atomic.enqueue"] = "no error";
      } catch (e) {
        out["atomic.enqueue"] = (e as Error).message;
      }
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
};
