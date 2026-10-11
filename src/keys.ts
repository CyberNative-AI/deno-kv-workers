// Deno KV key encoding, byte-for-byte compatible with the encoding Deno KV itself
// stores (an ordered tuple encoding). Byte order of encoded keys equals Deno's key order:
// Uint8Array < string < bigint < number < boolean.

export type KeyPart = Uint8Array | string | number | bigint | boolean;
export type Key = readonly KeyPart[];

const BYTES = 0x01, STRING = 0x02, INT_ZERO = 0x14, NEG_BIG = 0x0b, POS_BIG = 0x1d, DOUBLE = 0x21, FALSE = 0x26, TRUE = 0x27;

const te = new TextEncoder();
const td = new TextDecoder();

function pushEscaped(out: number[], bytes: Uint8Array) {
  for (const b of bytes) {
    out.push(b);
    if (b === 0) out.push(0xff);
  }
  out.push(0);
}

function bigintBytes(n: bigint): number[] {
  const b: number[] = [];
  while (n > 0n) {
    b.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return b;
}

function pushBigInt(out: number[], v: bigint) {
  if (v === 0n) {
    out.push(INT_ZERO);
    return;
  }
  const mag = bigintBytes(v < 0n ? -v : v);
  if (mag.length > 255) throw new RangeError("bigint key part is too large");
  if (v > 0n) {
    if (mag.length <= 8) out.push(INT_ZERO + mag.length, ...mag);
    else out.push(POS_BIG, mag.length, ...mag);
  } else {
    const inv = mag.map((b) => b ^ 0xff);
    if (mag.length <= 8) out.push(INT_ZERO - mag.length, ...inv);
    else out.push(NEG_BIG, mag.length ^ 0xff, ...inv);
  }
}

function pushDouble(out: number[], v: number) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Number.isNaN(v) ? NaN : v, false); // canonical NaN, as Deno stores it
  const b = new Uint8Array(dv.buffer);
  if (b[0] & 0x80) { for (let i = 0; i < 8; i++) b[i] ^= 0xff; }
  else b[0] ^= 0x80;
  out.push(DOUBLE, ...b);
}

export function encodeKey(key: Key): Uint8Array {
  const out: number[] = [];
  for (const p of key) {
    if (p instanceof Uint8Array) {
      out.push(BYTES);
      pushEscaped(out, p);
    } else if (typeof p === "string") {
      out.push(STRING);
      pushEscaped(out, te.encode(p));
    } else if (typeof p === "bigint") pushBigInt(out, p);
    else if (typeof p === "number") pushDouble(out, p);
    else if (typeof p === "boolean") out.push(p ? TRUE : FALSE);
    else throw new TypeError(`unsupported key part type: ${typeof p}`);
  }
  return new Uint8Array(out);
}

export function decodeKey(b: Uint8Array): KeyPart[] {
  const parts: KeyPart[] = [];
  let i = 0;
  const readEscaped = () => {
    const out: number[] = [];
    for (;;) {
      if (i >= b.length) throw new Error("bad key encoding: unterminated part");
      const c = b[i++];
      if (c === 0) {
        if (b[i] === 0xff) {
          out.push(0);
          i++;
          continue;
        }
        return new Uint8Array(out);
      }
      out.push(c);
    }
  };
  const readUint = (len: number, invert: boolean) => {
    let n = 0n;
    for (let j = 0; j < len; j++) n = (n << 8n) | BigInt(invert ? b[i++] ^ 0xff : b[i++]);
    return n;
  };
  while (i < b.length) {
    const t = b[i++];
    if (t === BYTES) parts.push(readEscaped());
    else if (t === STRING) parts.push(td.decode(readEscaped()));
    else if (t === INT_ZERO) parts.push(0n);
    else if (t > INT_ZERO && t < POS_BIG) parts.push(readUint(t - INT_ZERO, false));
    else if (t === POS_BIG) parts.push(readUint(b[i++], false));
    else if (t < INT_ZERO && t > NEG_BIG) parts.push(-readUint(INT_ZERO - t, true));
    else if (t === NEG_BIG) parts.push(-readUint(b[i++] ^ 0xff, true));
    else if (t === DOUBLE) {
      const x = b.slice(i, i + 8);
      i += 8;
      if (x[0] & 0x80) x[0] ^= 0x80;
      else for (let j = 0; j < 8; j++) x[j] ^= 0xff;
      parts.push(new DataView(x.buffer).getFloat64(0, false));
    } else if (t === FALSE || t === TRUE) parts.push(t === TRUE);
    else throw new Error(`bad key encoding: tag 0x${t.toString(16)}`);
  }
  return parts;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
