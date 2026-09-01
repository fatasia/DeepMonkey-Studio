/** 对模型结构、元数据与缩略图做轻量质量判定；性能复杂度不冒充视觉质量。 */
export function assessExternalAssetQuality(model, modelAudit, thumbnailAudit) {
  let score = 100;
  const issues = [];
  const blockers = [];

  block(!modelAudit.valid, "model-invalid", 100);
  block(Boolean(modelAudit.duplicateOf), "duplicate-content", 100);
  block(modelAudit.qualityTier === "review" || modelAudit.qualityTier === "invalid", "model-needs-review", 60);
  block((modelAudit.meshCount ?? 0) <= 0 || (modelAudit.primitiveCount ?? 0) <= 0, "geometry-empty", 100);
  block(!thumbnailAudit?.valid, "thumbnail-unqualified", 45);

  warn(!cleanText(model?.name), "name-missing", 20);
  warn(!cleanText(model?.type?.name), "category-missing", 12);
  warn(!cleanText(model?.element?.name), "subcategory-missing", 5);
  warn(!cleanText(model?.style?.name), "style-missing", 3);
  warn(!modelAudit.dimensions, "bounds-missing", 5);
  warn((modelAudit.materialCount ?? 0) === 0, "material-missing", 3);
  score -= Math.max(0, 100 - (thumbnailAudit?.qualityScore ?? 0)) * 0.2;

  const qualityScore = Math.max(0, Math.round(score));
  return {
    status: blockers.length === 0 && qualityScore >= 70 ? "ready" : "review-required",
    qualityScore,
    issues,
  };

  function block(condition, code, penalty) {
    if (!condition) return;
    blockers.push(code);
    issues.push(code);
    score -= penalty;
  }

  function warn(condition, code, penalty) {
    if (!condition) return;
    issues.push(code);
    score -= penalty;
  }
}

function cleanText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
