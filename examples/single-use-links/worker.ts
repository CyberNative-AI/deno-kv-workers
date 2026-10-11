// The same app on Cloudflare Workers. Only these lines are new.
import "../../src/shim.ts"; // in your app: import "deno-kv-workers/shim";
import { handleMigration } from "../../src/migrate.ts";
import { handle } from "./app.ts";
export { DenoKvObject } from "../../src/object.ts";

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    return (await handleMigration(req, env)) ?? handle(req, await Deno.openKv());
  },
};
