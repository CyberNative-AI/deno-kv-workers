// Optional: `import "deno-kv-workers/shim"` (first import of your Worker) installs `Deno.openKv()`
// and `Deno.KvU64` backed by the DENO_KV Durable Object binding, so most app code runs unchanged.
// Needs a compatibility date that supports `import { env } from "cloudflare:workers"`.
import { env } from "cloudflare:workers";
import { KvU64, openKv } from "./client.ts";

const D = ((globalThis as { Deno?: Record<string, unknown> }).Deno ??= {});
D.KvU64 ??= KvU64;
D.openKv = (path?: string) => {
  if (path) return Promise.reject(new Error("Deno.openKv(path) is not supported on Workers; data lives in the DENO_KV Durable Object"));
  const ns = (env as unknown as Record<string, unknown>).DENO_KV;
  if (!ns) return Promise.reject(new Error("Deno.openKv(): no DENO_KV Durable Object binding in wrangler config"));
  return Promise.resolve(openKv(ns as never));
};
