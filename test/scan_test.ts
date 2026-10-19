// The expireIn scanner on a fixture with the shapes real apps use.
import { deepStrictEqual as assertEquals } from "node:assert";
import { draftPolicy, scanSource } from "../tools/scan.ts";
import { applyPolicy } from "../tools/import.ts";
import { keyToJSON, valueToJSON } from "../src/vendor/kv_json.ts";

Deno.test("scan: finds expireIn writes by key prefix and drafts a conservative TTL policy", async () => {
  const src = await Deno.readTextFile(new URL("./fixtures/scan-app/main.ts", import.meta.url));
  const findings = scanSource("main.ts", src);
  assertEquals(findings.map((f) => [f.line, f.prefix, f.exact, f.expireInMs]), [
    [7, ["ratelimit"], false, 3_600_000],
    [8, ["uniq"], false, 86_400_000],
    [10, ["daily"], false, 604_800_000],
    [12, ["sessions"], false, 604_800_000],
    [13, ["daily", "summary"], true, 2_592_000_000],
    [15, ["dynamic"], false, null],
  ]);
  const { rules, review } = draftPolicy(findings);
  assertEquals(rules.map((r) => [r.prefix, r.exact, r.expireIn]), [
    [["ratelimit"], false, 3_600_000],
    [["uniq"], false, 86_400_000],
    [["daily"], false, 604_800_000],
    [["sessions"], false, 604_800_000],
    [["daily", "summary"], true, 2_592_000_000],
  ]);
  assertEquals(review.map((f) => f.line), [15]);
});

Deno.test("scan + import: a fully literal key keeps its own window, not a shorter one on its parent prefix", async () => {
  // An export without expiry (hosted Deno Deploy, @deno/kv-utils) gets all its expiry from this policy.
  const src = await Deno.readTextFile(new URL("./fixtures/scan-app/main.ts", import.meta.url));
  const { rules } = draftPolicy(scanSource("main.ts", src));
  const policy = JSON.parse(JSON.stringify({ rules: rules.map(({ prefix, exact, expireIn }) => ({ prefix, exact, expireIn })) }));
  const now = 1_000_000;
  const entry = (key: Deno.KvKey) => ({ key: keyToJSON(key), value: valueToJSON(0), versionstamp: "00000000000000010000" });
  const entries = [
    entry(["daily", "summary"]),
    entry(["daily", "2026-10-19", "1.2.3.4"]),
    entry(["daily", "summary", "extra"]),
    entry(["ratelimit", "1.2.3.4"]),
    entry(["ratelimit"]),
  ] as { key: unknown[]; value: unknown; versionstamp: string; expireAt?: number }[];
  applyPolicy(entries, policy.rules, now);
  assertEquals(entries.map((e) => e.expireAt ?? null), [
    now + 2_592_000_000, // the app writes this key with expireIn 30 days
    now + 604_800_000,
    now + 604_800_000, // below the exact key, not the key itself: the ["daily"] window
    now + 3_600_000,
    null, // the ["ratelimit"] key itself is never written with expireIn
  ]);
});
