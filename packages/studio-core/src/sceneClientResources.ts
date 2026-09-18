import { getSceneModelAssetId, type ApplicationDocument, type ModelRecord, type ProjectAssetRecord,
  type ProjectRecord, type SceneSnapshot, type SceneDashboardWidgetState } from "@bim-studio/contracts";

interface ResourceClaim { bytes?: number; sha256?: string; integrity?: string }
export interface SceneClientResource { id: string; name: string; url: string; claims: ResourceClaim[] }
const materialUrls = ["baseColorMapUrl", "normalMapUrl", "emissiveMapUrl", "ambientOcclusionMapUrl", "roughnessMapUrl", "metalnessMapUrl"] as const;
function fail(path: string, message: string): never { throw new Error(`客户端资源 ${path}：${message}`); }

/** 按声明引用选择，返回前完成项目归属和缺失检查；网络读取由交付器执行。 */
export function selectSceneClientResources(project: ProjectRecord, scenes: readonly SceneSnapshot[], applications: readonly ApplicationDocument[]) {
  const models: ModelRecord[] = [], assets: ProjectAssetRecord[] = [], resources = new Map<string, SceneClientResource>();
  const selectedModels = new Set<string>(), selectedAssets = new Set<string>();
  const modelIndex = index(project.models, "models"), assetIndex = index(project.assets ?? [], "assets");
  const byUrl = new Map<string, ProjectAssetRecord[]>();
  for (const asset of project.assets ?? []) for (const url of new Set([asset.url, ...(asset.maps ?? []).map(map => map.url)])) {
    if (url) byUrl.set(url, [...(byUrl.get(url) ?? []), asset]);
  }
  const add = (id: string, name: string, url: string | undefined, path: string, claim: ResourceClaim = {}) => {
    if (!url?.trim()) fail(path, "缺少资源 URL");
    if (claim.bytes !== undefined && (!Number.isSafeInteger(claim.bytes) || claim.bytes < 0)) fail(path, "资源大小无效");
    if (claim.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(claim.sha256)) fail(path, "资源 SHA-256 无效");
    if (claim.integrity !== undefined && !/^sha256-[A-Za-z0-9+/]{43}=$/.test(claim.integrity)) fail(path, "脚本依赖 integrity 无效");
    const existing = resources.get(url);
    if (existing) existing.claims.push(claim);
    else resources.set(url, { id, name, url, claims: [claim] });
  };
  const selectAsset = (asset: ProjectAssetRecord, path: string) => {
    if (asset.projectId !== project.id) fail(path, "资源属于其他项目");
    if (selectedAssets.has(asset.id)) return;
    selectedAssets.add(asset.id); assets.push(structuredClone(asset));
    add(`asset-${asset.id}`, asset.fileName || asset.name, asset.url, path, { bytes: asset.size });
    for (const [i, map] of (asset.maps ?? []).entries()) add(`asset-${asset.id}-map-${i}`, map.name, map.url, `${path}.maps[${i}]`, { bytes: map.size, sha256: map.contentHash });
  };
  const reference = (url: string | undefined, path: string, assetId?: string) => {
    if (assetId) {
      const asset = assetIndex.get(assetId) ?? fail(path, `资源 ${assetId} 不存在`);
      if (url && url !== asset.url && !asset.maps?.some(map => map.url === url)) fail(path, "资源 ID 与 URL 不匹配");
      selectAsset(asset, path); return;
    }
    if (!url || url.startsWith("data:")) return;
    const matches = byUrl.get(url) ?? [];
    if (!matches.length) fail(path, "URL 未登记为项目资源");
    for (const asset of matches) selectAsset(asset, path);
  };
  const widget = (value: Partial<SceneDashboardWidgetState>, path: string) => {
    if (value.type === "image") reference(value.imageUrl, `${path}.imageUrl`, value.assetId);
    if (value.type === "video") reference(value.videoUrl, `${path}.videoUrl`, value.assetId);
    reference(value.componentBackgroundImageUrl, `${path}.componentBackgroundImageUrl`);
  };
  for (const [sceneIndex, scene] of scenes.entries()) {
    const path = `scenes[${sceneIndex}]`;
    if (scene.projectId !== project.id) fail(path, "场景属于其他项目");
    reference(scene.environment?.environmentMapUrl, `${path}.environment.environmentMapUrl`);
    for (const [i, item] of scene.models.entries()) {
      const id = getSceneModelAssetId(item), itemPath = `${path}.models[${i}]`;
      if (selectedModels.has(id)) continue;
      const model = modelIndex.get(id) ?? fail(itemPath, `模型资源 ${id} 不存在`);
      if (model.projectId !== project.id) fail(itemPath, "模型资源属于其他项目");
      if (model.status !== "ready" || !model.manifest?.geometryUrl) fail(itemPath, `模型资源 ${id} 尚未就绪或缺少几何`);
      selectedModels.add(id); models.push(structuredClone(model));
      add(`model-${id}`, model.name, model.manifest.geometryUrl, `${itemPath}.geometryUrl`);
      for (const field of ["hierarchyUrl", "propertiesUrl", "pmiUrl", "inspectionUrl"] as const) {
        if (model.manifest[field]) add(`model-${id}-${field}`, `${model.name}.${field}.json`, model.manifest[field], `${itemPath}.${field}`);
      }
      for (const [i, lod] of (model.manifest.lods ?? []).entries()) add(`model-${id}-lod-${i}`, `${model.name}.${lod.level}.glb`, lod.url, `${itemPath}.lods[${i}]`);
    }
    for (const [i, item] of [...scene.models, ...scene.primitives].entries()) {
      for (const field of materialUrls) reference(item.material?.[field], `${path}.objects[${i}].material.${field}`);
    }
    for (const [i, item] of (scene.dashboard?.widgets ?? []).entries()) widget(item, `${path}.dashboard.widgets[${i}]`);
  }
  for (const [i, app] of applications.entries()) {
    const path = `applications[${i}]`;
    if (app.metadata.projectId !== project.id) fail(path, "应用属于其他项目");
    for (const asset of app.assets) if (asset.projectId !== project.id) fail(`${path}.assets`, "资源声明属于其他项目");
    for (const [p, page] of app.pages.entries()) {
      reference(page.appearance?.backgroundImageUrl, `${path}.pages[${p}].appearance.backgroundImageUrl`);
      for (const [n, node] of page.nodes.entries()) if (node.kind === "data-widget") widget(node.widget, `${path}.pages[${p}].nodes[${n}]`);
    }
    for (const [d, dependency] of (app.scriptDependencies ?? []).entries()) {
      add(`dependency-${dependency.id}`, dependency.fileName, dependency.assetUrl, `${path}.scriptDependencies[${d}]`, { bytes: dependency.size, integrity: dependency.integrity });
    }
  }
  return { models, assets, resources: [...resources.values()] };
}

function index<T extends { id: string }>(values: readonly T[], path: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!value.id || result.has(value.id)) fail(path, "资源 ID 缺失或重复");
    result.set(value.id, value);
  }
  return result;
}

export async function verifySceneClientResource(resource: SceneClientResource, bytes: ArrayBuffer, signal: AbortSignal) {
  signal.throwIfAborted();
  for (const claim of resource.claims) if (claim.bytes !== undefined && bytes.byteLength !== claim.bytes) fail(resource.id, "实际字节数与资源记录不匹配");
  if (!resource.claims.some(claim => claim.sha256 || claim.integrity)) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  signal.throwIfAborted();
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const integrity = `sha256-${btoa(String.fromCharCode(...digest))}`;
  for (const claim of resource.claims) if ((claim.sha256 && claim.sha256 !== hex) || (claim.integrity && claim.integrity !== integrity)) fail(resource.id, "资源 hash 不匹配");
}
