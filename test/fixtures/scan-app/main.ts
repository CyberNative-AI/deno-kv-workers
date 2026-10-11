// Fixture for the expireIn scanner: the shapes real Deno KV apps use.
const HOUR = 60 * 60 * 1000;
const RL_PREFIX = "ratelimit";
const SESSION_TTL = 7 * 24 * HOUR;

export async function hit(kv: Deno.Kv, ip: string, day: string, sid: string, ttl: number) {
  await kv.set([RL_PREFIX, ip], 1, { expireIn: HOUR });
  await kv.set(["uniq", ip], true, { expireIn: 24 * HOUR });
  await kv.atomic()
    .set(["daily", day, ip], 1, { expireIn: 7 * 24 * 3600_000 })
    .commit();
  await kv.set(["sessions", sid], { sid }, { expireIn: SESSION_TTL });
  await kv.set(["daily", "summary"], 0, { expireIn: 30 * 24 * HOUR }); // longer window on the same prefix wins
  const key = ["dynamic", ip];
  await kv.set(key, 1, { expireIn: ttl }); // duration not resolvable statically
  const s = "kv.set(['fake'], 1, { expireIn: 5 })"; // inside a string: ignored
  /* kv.set(["comment"], 1, { expireIn: 5 }) */
  return s;
}
