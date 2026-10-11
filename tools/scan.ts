// List every `expireIn` write in a codebase by key prefix, and draft a TTL policy for tools/import.ts.
//
//   deno run --allow-read tools/scan.ts <app dir> [--policy-out ttl-policy.json]
//
// It is a static, best-effort scan: it reads `.set(key, value, { expireIn })` calls (plain and
// atomic), resolves literal key prefixes and constant arithmetic (including `const` names in the
// same file), and lists anything it cannot resolve as NEEDS REVIEW. Review the draft before use.

export type Finding = {
  file: string;
  line: number;
  keyText: string;
  prefix: string[] | null;
  expireInText: string;
  expireInMs: number | null;
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "build", "vendor"]);

function* walk(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) yield* walk(p);
    else if (e.isFile && /\.(m?[jt]sx?|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) yield p;
  }
}

// Replace comments, string/template text and regex literals with filler (keeping offsets and
// newlines) so bracket matching only sees code. Template `${...}` expressions stay code.
function mask(src: string): string {
  const out = src.split("");
  const blank = (k: number) => {
    if (src[k] !== "\n") out[k] = "_";
  };
  const stack: number[] = []; // brace depth at which each open template expression resumes
  let depth = 0, i = 0;
  const prevCode = (k: number) => {
    while (k >= 0 && /\s/.test(src[k])) k--;
    return k < 0 ? "" : out[k];
  };
  const template = () => { // i is just after a backtick or a closing `}` of an expression
    while (i < src.length) {
      if (src[i] === "\\") {
        blank(i++);
        blank(i++);
        continue;
      }
      if (src[i] === "`") {
        i++;
        return;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        stack.push(depth);
        depth++;
        i += 2;
        return;
      }
      blank(i++);
    }
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") out[i++] = " "; }
    else if (c === "/" && d === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") blank(i++);
        blank(i++);
      }
      i++;
    } else if (c === "`") {
      i++;
      template();
    } else if (
      c === "/" &&
      (prevCode(i - 1) === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevCode(i - 1)) ||
        /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))
    ) {
      let cls = false;
      i++;
      while (i < src.length && src[i] !== "\n" && (src[i] !== "/" || cls)) {
        if (src[i] === "\\") blank(i++);
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        blank(i++);
      }
      i++;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
      if (stack.length && stack.at(-1) === depth) {
        stack.pop();
        template();
      }
    } else i++;
  }
  return out.join("");
}

function matchClose(m: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < m.length; i++) {
    if (pairs[m[i]]) stack.push(pairs[m[i]]);
    else if (m[i] === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

function splitTop(m: string, src: string, from: number, to: number): string[] {
  const parts: string[] = [];
  let depth = 0, start = from;
  for (let i = from; i < to; i++) {
    if ("([{".includes(m[i])) depth++;
    else if (")]}".includes(m[i])) depth--;
    else if (m[i] === "," && depth === 0) {
      parts.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = src.slice(start, to).trim();
  if (last) parts.push(last);
  return parts;
}

function constants(src: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>[\]| ]+)?=\s*([^;\n]+)/g)) {
    map.set(m[1], m[2].trim().replace(/,$/, ""));
  }
  return map;
}

export function evalMs(expr: string, consts: Map<string, string>, depth = 0): number | null {
  if (depth > 5) return null;
  let e = expr.trim().replace(/\bas\s+const\b/g, "");
  e = e.replace(/(\d)_(?=\d)/g, "$1");
  e = e.replace(/(?<![\w$.])[A-Za-z_$][\w$.]*/g, (name) => {
    const v = consts.get(name);
    if (v === undefined) return "\u0000";
    const n = evalMs(v, consts, depth + 1);
    return n === null ? "\u0000" : `(${n})`;
  });
  if (!/^[\d\s+\-*/().eE]+$/.test(e)) return null;
  try {
    const n = Function(`"use strict"; return (${e});`)();
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function literalPrefix(keyText: string, consts: Map<string, string>, depth = 0): string[] | null {
  let t = keyText.trim().replace(/\s+as\s+const$/, "");
  if (/^[A-Za-z_$][\w$]*$/.test(t) && consts.has(t) && depth < 3) return literalPrefix(consts.get(t)!, consts, depth + 1);
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  t = t.slice(1, -1);
  const prefix: string[] = [];
  for (const part of splitTop(mask(t), t, 0, t.length)) {
    const s = part.match(/^(["'])((?:\\.|(?!\1).)*)\1$/) ?? part.match(/^(`)([^`$]*)`$/);
    if (s) prefix.push(s[2]);
    else if (/^[A-Z_][A-Z0-9_]*$/.test(part) && consts.has(part)) {
      const v = consts.get(part)!.match(/^(["'])(.*)\1$/);
      if (!v) break;
      prefix.push(v[2]);
    } else break;
  }
  return prefix;
}

export function scanSource(file: string, src: string): Finding[] {
  const m = mask(src);
  const consts = constants(src);
  const found: Finding[] = [];
  for (const hit of m.matchAll(/\bexpireIn\b/g)) {
    // innermost enclosing call whose callee ends in `.set`
    let depth = 0, open = -1;
    for (let i = hit.index! - 1; i >= 0; i--) {
      const c = m[i];
      if (")]}".includes(c)) depth++;
      else if ("([{".includes(c)) {
        if (depth > 0) depth--;
        else if (c === "(" && /\.set\s*$/.test(m.slice(Math.max(0, i - 20), i))) {
          open = i;
          break;
        }
      }
    }
    const line = src.slice(0, hit.index).split("\n").length;
    if (open < 0) {
      found.push({
        file,
        line,
        keyText: "(not a .set(...) call)",
        prefix: null,
        expireInText: src.slice(hit.index!, hit.index! + 40).split("\n")[0],
        expireInMs: null,
      });
      continue;
    }
    const close = matchClose(m, open);
    const args = splitTop(m, src, open + 1, close < 0 ? m.length : close);
    const opts = args[2] ?? "";
    const ex = opts.match(/expireIn\s*:\s*([^,}]+)/) ?? (/\bexpireIn\b/.test(opts) ? ["", "expireIn"] : null);
    const expireInText = ex ? ex[1].trim() : opts;
    found.push({
      file,
      line,
      keyText: args[0] ?? "",
      prefix: literalPrefix(args[0] ?? "", consts),
      expireInText,
      expireInMs: evalMs(expireInText, consts),
    });
  }
  return found;
}

export function draftPolicy(findings: Finding[]) {
  const byPrefix = new Map<string, { prefix: string[]; expireIn: number; sites: string[] }>();
  const review: Finding[] = [];
  for (const f of findings) {
    if (!f.prefix || f.prefix.length === 0 || f.expireInMs === null) {
      review.push(f);
      continue;
    }
    const k = JSON.stringify(f.prefix);
    const cur = byPrefix.get(k);
    // several windows on one prefix: take the longest, so no key expires earlier than on Deno
    if (!cur) byPrefix.set(k, { prefix: f.prefix, expireIn: f.expireInMs, sites: [`${f.file}:${f.line}`] });
    else {
      cur.expireIn = Math.max(cur.expireIn, f.expireInMs);
      cur.sites.push(`${f.file}:${f.line}`);
    }
  }
  return { rules: [...byPrefix.values()], review };
}

if (import.meta.main) {
  const root = Deno.args.find((a) => !a.startsWith("--"));
  if (!root) {
    console.error("usage: tools/scan.ts <app dir> [--policy-out FILE]");
    Deno.exit(2);
  }
  const findings: Finding[] = [];
  for (const f of walk(root)) {
    const src = Deno.readTextFileSync(f);
    if (src.includes("expireIn")) findings.push(...scanSource(f.slice(root.length + 1) || f, src));
  }
  const { rules, review } = draftPolicy(findings);
  console.log(`expireIn writes: ${findings.length}`);
  for (const f of findings) {
    console.log(
      `  ${f.file}:${f.line}  key ${f.keyText}  prefix ${f.prefix ? JSON.stringify(f.prefix) : "?"}  expireIn ${f.expireInText} = ${
        f.expireInMs ?? "?"
      } ms`,
    );
  }
  console.log(`\ndraft policy (${rules.length} prefixes):`);
  for (const r of rules) console.log(`  ${JSON.stringify(r.prefix)} expireIn ${r.expireIn} ms  (${r.sites.join(", ")})`);
  if (review.length) {
    console.log(`\nNEEDS REVIEW (${review.length}): prefix or duration not resolvable statically`);
    for (const f of review) console.log(`  ${f.file}:${f.line}  key ${f.keyText}  expireIn ${f.expireInText}`);
  }
  const out = Deno.args[Deno.args.indexOf("--policy-out") + 1];
  if (Deno.args.includes("--policy-out") && out) {
    Deno.writeTextFileSync(out, JSON.stringify({ rules: rules.map(({ prefix, expireIn }) => ({ prefix, expireIn })) }, null, 2) + "\n");
    console.log(`\nwrote ${out}`);
  }
}
