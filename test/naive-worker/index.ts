// Negative control for the verify harness: the example app on a store whose atomic commits
// ignore check(), the way a get-then-put port onto Workers KV behaves, with simulated read
// latency. verify.ts must flag it.
import "../../src/shim.ts";
import { handleMigration } from "../../src/migrate.ts";
import { handle } from "../../examples/single-use-links/app.ts";
export { DenoKvObject } from "../../src/object.ts";

// deno-lint-ignore no-explicit-any
function dropChecks(kv: any): Deno.Kv {
  return {
    // a remote key-value store answers reads with latency; 25 ms stands in for it
    get: async (...a: unknown[]) => {
      const r = await kv.get(...a);
      await new Promise((ok) => setTimeout(ok, 25));
      return r;
    },
    getMany: (...a: unknown[]) => kv.getMany(...a),
    set: (...a: unknown[]) => kv.set(...a),
    delete: (...a: unknown[]) => kv.delete(...a),
    list: (...a: unknown[]) => kv.list(...a),
    atomic() {
      const op = kv.atomic();
      const w = {
        check: () => w,
        set: (...a: unknown[]) => (op.set(...a), w),
        delete: (...a: unknown[]) => (op.delete(...a), w),
        sum: (...a: unknown[]) => (op.sum(...a), w),
        commit: () => op.commit(),
      };
      return w;
    },
  } as unknown as Deno.Kv;
}

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    return (await handleMigration(req, env)) ?? handle(req, dropChecks(await Deno.openKv()));
  },
};
