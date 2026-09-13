import { assertApplicationDocument, getSceneModelAssetId, type ApplicationDocument, type DataConnectionRecord,
  type DataDatasetRecord, type DataPipelineDefinition, type ModelRecord, type ProjectAssetRecord,
  type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";

export interface TransferFile {
  id: string; name: string; sourceUrl: string; path: string;
  sha256?: string; bytes?: number; missing?: boolean;
}
export interface TransferModel { originalId: string; name: string; fileId: string; robotEntryPath?: string; }
export interface TransferAsset { originalId: string; kind: ProjectAssetRecord["kind"]; name: string; fileId: string; maps?: Record<string, string>; }
export interface TransferDependency { originalId: string; specifier: string; fileId: string; }
export interface ProjectTransferDocument {
  kind: "bim-studio-project-package"; schemaVersion: 1; createdAt: string;
  project: Pick<ProjectRecord, "id" | "name" | "description">;
  scenes: SceneSnapshot[]; applications: ApplicationDocument[];
  models: TransferModel[]; assets: TransferAsset[]; dependencies: TransferDependency[]; files: TransferFile[];
  runtime: { connections: DataConnectionRecord[]; datasets: DataDatasetRecord[]; pipelines: DataPipelineDefinition[] };
  versions: Array<{ kind: "scene" | "application"; id: string; revision?: number; updatedAt: string; publishedAt?: string }>;
}

/** 配置按允许字段导出；不从整个 ProjectRecord 序列化数据库、AI 或运维配置。 */
export function createProjectTransfer(project: ProjectRecord, scenes: SceneSnapshot[], applications: ApplicationDocument[]): ProjectTransferDocument {
  const files: TransferFile[] = [];
  const add = (url: string, name: string) => {
    const existing = files.find(file => file.sourceUrl === url && url);
    if (existing) return existing.id;
    const id = `file-${files.length + 1}`;
    files.push({ id, name: safeTransferName(name), sourceUrl: url, path: `files/${id}/${safeTransferName(name)}` });
    return id;
  };
  const models = project.models.map(model => {
    const portable = portableModelFile(model);
    return { originalId: model.id, name: model.name, fileId: add(portable.url, portable.name),
      ...(model.manifest?.robot?.entryPath ? { robotEntryPath: model.manifest.robot.entryPath } : {}) };
  });
  const assets = (project.assets ?? []).map(asset => ({
    originalId: asset.id, kind: asset.kind, name: asset.name, fileId: add(asset.url, asset.fileName),
    ...(asset.maps?.length ? { maps: Object.fromEntries(asset.maps.map(map => [map.kind, add(map.url, map.name)])) } : {}),
  }));
  const dependencies: TransferDependency[] = [];
  for (const app of applications) for (const dependency of app.scriptDependencies ?? []) {
    if (!dependencies.some(item => item.originalId === dependency.id)) dependencies.push({ originalId: dependency.id,
      specifier: dependency.specifier, fileId: add(dependency.assetUrl, dependency.fileName) });
  }
  const connections = (project.dataConnections ?? []).map(connection => ({
    id: connection.id, projectId: project.id, name: connection.name, type: connection.type,
    enabled: connection.type === "simulation" && connection.enabled,
    config: connection.type === "simulation" ? safeSimulationConfig(connection.config) : {},
    createdAt: connection.createdAt, updatedAt: connection.updatedAt,
  }));
  const datasets = (project.datasets ?? []).map(dataset => ({
    id: dataset.id, projectId: project.id, connectionId: dataset.connectionId, name: dataset.name,
    refreshSeconds: dataset.refreshSeconds, fields: structuredClone(dataset.fields),
    ...(dataset.query !== undefined ? { query: dataset.query } : {}),
    ...(dataset.sourceKey !== undefined ? { sourceKey: dataset.sourceKey } : {}),
    ...(dataset.computedFields ? { computedFields: sanitizeTransferContent(dataset.computedFields) } : {}),
    createdAt: dataset.createdAt, updatedAt: dataset.updatedAt,
  }));
  const document: ProjectTransferDocument = {
    kind: "bim-studio-project-package", schemaVersion: 1, createdAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, description: project.description },
    scenes: sanitizeTransferContent(scenes), applications: sanitizeTransferContent(applications),
    models, assets, dependencies, files,
    runtime: { connections, datasets, pipelines: sanitizeTransferContent(project.dataPipelines ?? []) },
    versions: [...scenes.map(scene => ({ kind: "scene" as const, id: scene.id, updatedAt: scene.updatedAt,
      ...(scene.publishedAt ? { publishedAt: scene.publishedAt } : {}) })),
    ...applications.map(app => ({ kind: "application" as const, id: app.metadata.id, revision: app.metadata.revision, updatedAt: app.metadata.updatedAt }))],
  };
  // 缺失模型也进入清单，让导入者选择替代文件，而不是悄悄丢弃场景对象。
  for (const scene of [...scenes, ...applications.flatMap(app => app.scenes)]) for (const model of scene.models) {
    const originalId = getSceneModelAssetId(model);
    if (!document.models.some(item => item.originalId === originalId)) document.models.push({
      originalId, name: model.sourceName ?? model.name, fileId: add("", model.sourceName ?? `${model.name}.glb`),
    });
  }
  return document;
}

export function safeTransferName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 160) || "resource";
}
function portableModelFile(model: ModelRecord): { url: string; name: string } {
  const geometry = model.manifest?.geometryUrl ?? "";
  const extension = geometry.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  if (model.status === "ready" && extension && ["glb", "usdz", "zip"].includes(extension)) {
    return { url: geometry, name: `${model.name.replace(/\.[^.]+$/, "")}.${extension}` };
  }
  return { url: /^https?:|^\//.test(model.sourceUrl) ? model.sourceUrl : "", name: model.name };
}
export function safeSimulationConfig(config: DataConnectionRecord["config"]): DataConnectionRecord["config"] {
  try {
    const source = new URL(String(config.url));
    if (source.protocol !== "sim:") return {};
    const url = new URL(`sim://${source.hostname || "telemetry"}`);
    for (const key of ["rows", "seed", "interval", "start"]) if (source.searchParams.has(key)) url.searchParams.set(key, source.searchParams.get(key)!);
    return { url: url.toString() };
  } catch { return {}; }
}

/** 直接绑定包含连接参数，保留其字段/目标但导入后显式重新配置，绝不把凭据带进交付文件。 */
export function sanitizeTransferContent<T>(source: T): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).flatMap(([key, child]) => {
      if (/^(?:password|passwordEnv|token|accessToken|refreshToken|apiKey|secret|credential|authorization|headers|directBinding)$/i.test(key)) return [];
      return [[key, key === "enabled" && record.directBinding ? false : typeof child === "string" && /(?:url|src)$/i.test(key) ? sanitizeTransferUrl(child) : visit(child)]];
    }));
  };
  return visit(source) as T;
}

export function sanitizeTransferUrl(value: string): string {
  try {
    const url = new URL(value, "https://transfer.invalid");
    if (!["http:", "https:"].includes(url.protocol)) return value;
    url.username = ""; url.password = "";
    for (const key of [...url.searchParams.keys()]) if (/token|secret|key|credential|signature|authorization|x-amz-/i.test(key)) url.searchParams.delete(key);
    return value.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch { return value; }
}

export function validateProjectTransfer(value: unknown): asserts value is ProjectTransferDocument {
  if (!value || typeof value !== "object") throw new Error("项目包清单无效");
  const doc = value as ProjectTransferDocument;
  if (doc.kind !== "bim-studio-project-package" || doc.schemaVersion !== 1 || !doc.project?.id || !doc.project.name
    || !doc.runtime || ![doc.scenes, doc.applications, doc.models, doc.assets, doc.dependencies, doc.files,
      doc.runtime.connections, doc.runtime.datasets, doc.runtime.pipelines, doc.versions].every(Array.isArray)) throw new Error("项目包结构或版本不受支持");
  if (doc.files.length > 4096 || doc.scenes.length > 1000 || doc.applications.length > 1000) throw new Error("项目包条目超过限制");
  const ids = new Set<string>();
  for (const file of doc.files) {
    if (typeof file.id !== "string" || ids.has(file.id) || typeof file.name !== "string" || typeof file.sourceUrl !== "string"
      || !/^files\/[A-Za-z0-9_-]+\/[^/\\]+$/.test(file.path) || file.path.includes("..")) throw new Error("项目包资源标识或路径无效");
    ids.add(file.id);
  }
  for (const scene of doc.scenes) if (scene.schemaVersion !== 1 || !scene.id || !Array.isArray(scene.models) || !Array.isArray(scene.primitives)) throw new Error("项目包场景无效");
  for (const app of doc.applications) assertApplicationDocument(app);
  for (const resource of [...doc.models, ...doc.assets, ...doc.dependencies]) if (!ids.has(resource.fileId)) throw new Error("项目包存在未声明的文件引用");
  for (const asset of doc.assets) if (!["image", "video", "environment", "pbr-material"].includes(asset.kind)
    || Object.values(asset.maps ?? {}).some(id => !ids.has(id))) throw new Error("项目包资源类型或贴图引用无效");
  const connectionIds = new Set(doc.runtime.connections.map(item => item.id));
  for (const dataset of doc.runtime.datasets) if (!connectionIds.has(dataset.connectionId)) throw new Error("项目包数据集缺少连接配置");
}
