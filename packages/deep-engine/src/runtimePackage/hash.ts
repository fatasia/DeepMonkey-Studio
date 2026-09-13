import { sha256Utf8 } from "../shaderPackage/hash.js";
import { snapshotJson } from "./primitives.js";
import type { RuntimeJson } from "./types.js";

/** 自有 v1 canonical（非 JCS）：JSON 标点/数组顺序/字符串转义，键按 Unicode 标量序。
 * 数字为 n + binary64 大端小写十六进制；-0 等同 0。域前缀隔离其他合同的 SHA256。
 */
export const RUNTIME_CANONICAL_DOMAIN = "deep-engine.runtime-package.canonical.v1\n";
export function compareRuntimeStrings(left: string, right: string): number {
  const a = [...left], b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
function canonical(value: RuntimeJson, binaryNumbers = true): string {
  if (typeof value === "number" && binaryNumbers) {
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, value === 0 ? 0 : value, false);
    return `n${bytes.getUint32(0).toString(16).padStart(8, "0")}${bytes.getUint32(4).toString(16).padStart(8, "0")}`;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, binaryNumbers)).join(",")}]`;
  const object = value as Readonly<Record<string, RuntimeJson>>;
  return `{${Object.keys(object).sort(compareRuntimeStrings).map(key => `${JSON.stringify(key)}:${canonical(object[key]!, binaryNumbers)}`).join(",")}}`;
}
export const orderedRuntimeJson = (value: RuntimeJson): string => canonical(value, false);
export function runtimeContentSha256(value: unknown): string {
  return sha256Utf8(RUNTIME_CANONICAL_DOMAIN + canonical(snapshotJson(value)));
}
export function runtimePackageSha256(value: { readonly [key: string]: unknown }): string {
  const { packageHash: _ignored, ...core } = value;
  return runtimeContentSha256(core);
}
