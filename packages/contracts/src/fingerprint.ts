/**
 * 跨端一致的 canonical 序列化与 64 位指纹。
 * 浏览器、Node、Worker 三端必须对同一输入产生位级一致的指纹:
 * 不使用 node:crypto(Web 侧不可用),使用纯 JS FNV-1a 64(BigInt)。
 * 指纹用于黄金样例、复现与证据链比对,不是密码学摘要。
 */

export class FingerprintInputError extends Error {}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** 递归收集被 JSON.stringify 视为循环的对象引用,命中即拒绝。 */
function collectObjectSources(value: unknown, seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new FingerprintInputError("指纹输入包含循环引用");
  seen.add(value);
  for (const item of value instanceof Array ? value : Object.values(value)) {
    collectObjectSources(item, seen);
  }
  seen.delete(value);
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    const numeric = value as number;
    // -0 与 0 在 IEEE754 比较相等但序列化不同;指纹必须归一。
    if (Object.is(numeric, -0)) return 0;
    if (!Number.isFinite(numeric)) {
      throw new FingerprintInputError(`指纹输入包含非有限数字(${String(numeric)})`);
    }
    return numeric;
  }
  if (type === "bigint") throw new FingerprintInputError("指纹输入不支持 bigint");
  if (type !== "object") {
    throw new FingerprintInputError(`指纹输入不支持 ${type} 类型`);
  }
  if (value instanceof Array) {
    if (seen.has(value)) throw new FingerprintInputError("指纹输入包含循环引用");
    seen.add(value);
    const items = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return items;
  }
  if (value instanceof Date) {
    throw new FingerprintInputError("指纹输入不支持 Date;请先转换为 ISO 字符串");
  }
  const record = value as Record<string, unknown>;
  if (seen.has(record)) throw new FingerprintInputError("指纹输入包含循环引用");
  seen.add(record);
  const keys = Object.keys(record).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) continue;
    normalized[key] = canonicalize(item, seen);
  }
  seen.delete(record);
  return normalized;
}

/** 键排序、剔除 undefined、归一 -0 的确定性 JSON 文本;非 JSON 值显式拒绝。 */
export function canonicalJson(value: unknown): string {
  collectObjectSources(value, new Set<object>());
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function utf8Bytes(text: string): number[] {
  // TextEncoder 在浏览器/Node/Worker 三端均可用且输出一致。
  return Array.from(new TextEncoder().encode(text));
}

/** FNV-1a 64 位指纹,输出 16 位小写十六进制;同文本恒同值。 */
export function fingerprint64(value: unknown): string {
  const bytes = utf8Bytes(canonicalJson(value));
  let hash = FNV_OFFSET_64;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 组合指纹:按既定标签逐段掺入,字段增删会改变结果(防字段拼接近似碰撞)。 */
export function fingerprint64Labeled(parts: ReadonlyArray<readonly [string, unknown]>): string {
  const material: Record<string, unknown> = {};
  for (const [label, value] of parts) {
    material[label] = value;
  }
  return fingerprint64(material);
}
