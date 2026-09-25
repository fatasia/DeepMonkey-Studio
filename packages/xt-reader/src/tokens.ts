/**
 * X_T 文本 token 层：latin1 解码与数值 token 解析。
 * Parasolid 文本里的折行是排版换行而不是分隔符，必须先整体去除再切 token。
 */
export type Vec3 = [number, number, number];

export function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

/** Parasolid 数值允许连续正负号前缀（如 "+-.5"）；符号数量决定正负。 */
export function parseXtNumber(token: string): number {
  const signMatch = /^[+-]+/.exec(token);
  const sign = signMatch ? (signMatch[0].length % 2 === 1 ? -1 : 1) : 1;
  const rest = signMatch ? token.slice(signMatch[0].length) : token;
  if (!/^\d+(\.\d*)?([eE][+-]?\d+)?$/.test(rest) && !/^\.\d+([eE][+-]?\d+)?$/.test(rest)) return Number.NaN;
  return sign * Number(rest);
}

export function isNumberToken(token: string): boolean {
  return Number.isFinite(parseXtNumber(token));
}

export function isIntegerToken(token: string): boolean {
  return /^[+-]?\d+$/.test(token);
}

export function tokenizePayload(payloadText: string): string[] {
  return payloadText.split(/\s+/).filter(Boolean);
}

export function readVec3(tokens: readonly string[], offset: number): Vec3 | undefined {
  const x = parseXtNumber(tokens[offset] ?? "");
  const y = parseXtNumber(tokens[offset + 1] ?? "");
  const z = parseXtNumber(tokens[offset + 2] ?? "");
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return [x, y, z];
}

export function vectorLength(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

export function isUnitVector(vector: Vec3, tolerance = 5e-3): boolean {
  return Math.abs(vectorLength(vector) - 1) < tolerance;
}

export function isOrthogonal(a: Vec3, b: Vec3, tolerance = 2e-3): boolean {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < tolerance;
}

export function dotProduct(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
