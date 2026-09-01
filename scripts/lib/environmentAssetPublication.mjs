const REQUIRED_MAPS = {
  environment: ["environment"],
  material: ["base-color", "normal", "roughness"],
};

/**
 * 环境与材质只有在必需贴图、预览图和完整性元数据齐全时才能进入生产目录。
 * 这里保持纯函数，既供同步脚本使用，也便于发布门禁覆盖缺图和哈希异常。
 */
export function assessEnvironmentAssetPublication(asset) {
  const files = new Map((asset.files ?? []).map((file) => [file.fileName, file]));
  const mapFiles = new Map((asset.maps ?? []).map((map) => [map.kind, map.fileName]));
  const issues = [];

  for (const kind of REQUIRED_MAPS[asset.category] ?? []) {
    const fileName = mapFiles.get(kind);
    if (!fileName) issues.push(`missing-map:${kind}`);
    else if (!files.has(fileName)) issues.push(`missing-file:${fileName}`);
  }
  if (!files.has("thumbnail.png")) issues.push("missing-thumbnail");

  for (const file of files.values()) {
    if (!Number.isFinite(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(file.sha256 ?? "")) {
      issues.push(`invalid-integrity:${file.fileName}`);
    }
  }

  return { ready: issues.length === 0, issues };
}
