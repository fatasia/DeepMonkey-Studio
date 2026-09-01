function mixState(aValue: number, bValue: number, cValue: number): [number, number, number] {
  let a = aValue >>> 0;
  let b = bValue >>> 0;
  let c = cValue >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 13)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 8)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 13)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 12)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 16)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 5)) >>> 0;
  a = (a - b - c) >>> 0; a = (a ^ (c >>> 3)) >>> 0;
  b = (b - c - a) >>> 0; b = (b ^ (a << 10)) >>> 0;
  c = (c - a - b) >>> 0; c = (c ^ (b >>> 15)) >>> 0;
  return [a, b, c];
}

/** JT Annex C 的 32 位 Jenkins hash2；所有运算都显式回绕到 UInt32。 */
export function jtHash32(words: readonly number[], seed = 0): number {
  let a = 0x9e37_79b9;
  let b = 0x9e37_79b9;
  let c = seed >>> 0;
  let remaining = words.length;
  let offset = 0;

  while (remaining >= 3) {
    a = (a + (words[offset] ?? 0)) >>> 0;
    b = (b + (words[offset + 1] ?? 0)) >>> 0;
    c = (c + (words[offset + 2] ?? 0)) >>> 0;
    [a, b, c] = mixState(a, b, c);
    offset += 3;
    remaining -= 3;
  }
  c = (c + words.length) >>> 0;
  if (remaining === 2) b = (b + (words[offset + 1] ?? 0)) >>> 0;
  if (remaining >= 1) a = (a + (words[offset] ?? 0)) >>> 0;
  [a, b, c] = mixState(a, b, c);
  return c >>> 0;
}

/** JT Annex C 的 16 位 Jenkins hash3，用于拓扑顶点标志。 */
export function jtHash16(shorts: readonly number[], seed = 0): number {
  let a = 0x9e37_79b9;
  let b = 0x9e37_79b9;
  let c = seed >>> 0;
  let remaining = shorts.length;
  let offset = 0;
  while (remaining >= 6) {
    a = (a + ((shorts[offset]! & 0xffff) | ((shorts[offset + 1]! & 0xffff) << 16))) >>> 0;
    b = (b + ((shorts[offset + 2]! & 0xffff) | ((shorts[offset + 3]! & 0xffff) << 16))) >>> 0;
    c = (c + ((shorts[offset + 4]! & 0xffff) | ((shorts[offset + 5]! & 0xffff) << 16))) >>> 0;
    [a, b, c] = mixState(a, b, c);
    offset += 6;
    remaining -= 6;
  }
  c = (c + shorts.length) >>> 0;
  if (remaining === 5) c = (c + ((shorts[offset + 4]! & 0xffff) << 16)) >>> 0;
  if (remaining >= 4) b = (b + ((shorts[offset + 3]! & 0xffff) << 16)) >>> 0;
  if (remaining >= 3) b = (b + (shorts[offset + 2]! & 0xffff)) >>> 0;
  if (remaining >= 2) a = (a + ((shorts[offset + 1]! & 0xffff) << 16)) >>> 0;
  if (remaining >= 1) a = (a + (shorts[offset]! & 0xffff)) >>> 0;
  [, , c] = mixState(a, b, c);
  return c >>> 0;
}
