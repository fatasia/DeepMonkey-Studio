import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const ENVIRONMENT_ID = "industrial_sunset_puresky";
const MATERIAL_ID = "concrete_floor_worn_001";
const MODEL_FIXTURE = "data/external-assets/source-a/models/1765947545875.glb";

/** 从已同步素材中提取最小验收子集，避免门禁复制整个 3GB 素材库。 */
export function prepareAssetMaterialFixture(repositoryRoot, dataRoot) {
  const sourceRoot = resolve(repositoryRoot, "data/external-assets/environment-materials");
  const targetRoot = resolve(dataRoot, "external-assets/environment-materials");
  const sourceCatalog = JSON.parse(readFileSync(resolve(sourceRoot, "catalog.json"), "utf8"));
  const environment = requiredAsset(sourceCatalog.assets, ENVIRONMENT_ID);
  const material = requiredAsset(sourceCatalog.assets, MATERIAL_ID);
  const deprecated = { ...structuredClone(material), id: "deprecated_surface", name: "已废弃表面", publicationStatus: "deprecated" };
  const hashMismatch = structuredClone(material);
  hashMismatch.id = "hash_mismatch_surface";
  hashMismatch.name = "完整性异常表面";
  hashMismatch.files[0].sha256 = "0".repeat(64);
  const missingThumbnail = structuredClone(material);
  missingThumbnail.id = "missing_thumbnail_surface";
  missingThumbnail.name = "缺少缩略图表面";
  missingThumbnail.files = missingThumbnail.files.filter((file) => file.fileName !== "thumbnail.png");

  for (const asset of [environment, material, deprecated, hashMismatch]) {
    copyAssetDirectory(sourceRoot, targetRoot, asset, asset.id === deprecated.id || asset.id === hashMismatch.id ? material.id : asset.id);
  }
  mkdirSync(resolve(targetRoot, missingThumbnail.category, missingThumbnail.id), { recursive: true });
  writeFileSync(resolve(targetRoot, "catalog.json"), `${JSON.stringify({ schemaVersion: 1, assets: [environment, material, deprecated, hashMismatch, missingThumbnail] }, null, 2)}\n`);

  const modelRoot = resolve(dataRoot, "external-assets/source-a");
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(resolve(modelRoot, "catalog.json"), "{\"models\":[],\"files\":[]}\n");
  writeFileSync(resolve(modelRoot, "audit.json"), "{\"items\":[]}\n");
  const modelFixturePath = resolve(repositoryRoot, MODEL_FIXTURE);
  if (!existsSync(modelFixturePath)) throw new Error(`缺少真实 GLB 验收模型：${modelFixturePath}`);
  return {
    assetLibraryDir: modelRoot,
    modelFixture: {
      path: modelFixturePath,
      fileName: basename(modelFixturePath),
      catalogId: 1324,
      name: "车间_机械设备0033",
      triangles: 3960,
    },
    expected: {
      environment: `environment-${ENVIRONMENT_ID}`,
      material: `material-${MATERIAL_ID}`,
      deprecated: "material-deprecated_surface",
      hashMismatch: "material-hash_mismatch_surface",
      missingThumbnail: "material-missing_thumbnail_surface",
    },
  };
}

function requiredAsset(assets, id) {
  const asset = assets.find((candidate) => candidate.id === id);
  if (!asset) throw new Error(`本地素材清单缺少验收资源：${id}`);
  return structuredClone(asset);
}

function copyAssetDirectory(sourceRoot, targetRoot, asset, sourceId) {
  const source = resolve(sourceRoot, asset.category, sourceId);
  const target = resolve(targetRoot, asset.category, asset.id);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  for (const file of asset.files) file.fileName = basename(file.fileName);
}
