// The expireIn scanner on a fixture with the shapes real apps use.
import { deepStrictEqual as assertEquals } from "node:assert";
import { draftPolicy, scanSource } from "../tools/scan.ts";

Deno.test("scan: finds expireIn writes by key prefix and drafts a conservative TTL policy", async () => {
  const src = await Deno.readTextFile(new URL("./fixtures/scan-app/main.ts", import.meta.url));
  const findings = scanSource("main.ts", src);
  assertEquals(findings.map((f) => [f.line, f.prefix, f.expireInMs]), [
    [7, ["ratelimit"], 3_600_000],
    [8, ["uniq"], 86_400_000],
    [10, ["daily"], 604_800_000],
    [12, ["sessions"], 604_800_000],
    [13, ["daily", "summary"], 2_592_000_000],
    [15, ["dynamic"], null],
  ]);
  const { rules, review } = draftPolicy(findings);
  assertEquals(rules.map((r) => [r.prefix, r.expireIn]), [
    [["ratelimit"], 3_600_000],
    [["uniq"], 86_400_000],
    [["daily"], 604_800_000],
    [["sessions"], 604_800_000],
    [["daily", "summary"], 2_592_000_000],
  ]);
  assertEquals(review.map((f) => f.line), [15]);
});
