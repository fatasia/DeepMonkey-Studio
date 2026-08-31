export const EVIDENCE_FINGERPRINT_ALGORITHM = "fnv1a64-canonical-v1" as const;

/**
 * 为本地确定性工作流生成跨刷新稳定的证据指纹。它用于发现输入或结论变化，
 * 不是签名或防篡改凭据；需要抗抵赖时仍应由服务端追加 SHA-256 审计记录。
 */
export function createEvidenceFingerprint(value: unknown): string {
  const canonical = JSON.stringify(canonicalValue(value));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${EVIDENCE_FINGERPRINT_ALGORITHM}:${hash.toString(16).padStart(16, "0")}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return String(value);
}
