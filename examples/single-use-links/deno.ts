// deno run --unstable-kv -A examples/single-use-links/deno.ts [kv path] [port]
import { handle } from "./app.ts";
const kv = await Deno.openKv(Deno.args[0] ?? "links.sqlite");
Deno.serve({ port: Number(Deno.args[1] ?? 8000), hostname: "127.0.0.1" }, (req) => handle(req, kv));
