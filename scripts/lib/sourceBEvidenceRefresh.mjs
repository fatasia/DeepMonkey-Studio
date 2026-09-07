import { sourceBModelLicense } from "./sourceBModelPolicy.mjs";

/** 当前官方许可与缓存字节分别取证；不把元数据补全当作视觉放行。 */
export function refreshedSourceBEvidence(record, detail, inspection, now) {
  if (detail.uid !== record.uid) throw new Error("官方响应 UID 不匹配");
  const provenance = sourceBModelLicense(detail);
  if (!provenance) throw new Error("官方许可不在允许清单或缺少完整署名");
  if (!inspection.valid || !inspection.meshCount || !inspection.primitiveCount || inspection.externalUris?.length
    || inspection.sha256 !== record.sha256 || inspection.bytes !== record.bytes) throw new Error("缓存结构或哈希不匹配");
  return { ...record, ...provenance, modelAudit: inspection, licenseVerifiedAt: now, publicationStatus: "review-required" };
}
