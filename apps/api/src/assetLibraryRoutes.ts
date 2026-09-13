import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AssetLibraryDimension, AssetLibraryImportResult, ModelRecord, ProjectAssetRecord, ProjectRecord } from "@bim-studio/contracts";
import { AssetLibraryCatalog, type AssetLibraryCatalogEntry } from "./assetLibraryCatalog.js";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";

interface AssetLibraryRouteDependencies {
  store: MetadataStore;
  queue: ConversionQueue;
  objects: ObjectStore;
  dataDir: string;
  libraryDir: string;
}

interface AssetLibraryListQuery {
  q?: string;
  dimension?: string;
  category?: string;
  animated?: string;
  featured?: string;
  page?: string;
  pageSize?: string;
}

export async function registerAssetLibraryRoutes(app: FastifyInstance, dependencies: AssetLibraryRouteDependencies): Promise<void> {
  const imports = new Map<string, Promise<AssetLibraryImportResult>>();
  const catalog = new AssetLibraryCatalog(
    dependencies.libraryDir,
    path.join(dependencies.dataDir, "external-assets", "environment-materials"),
    path.join(dependencies.dataDir, "external-assets", "source-b"),
  );

  app.get<{ Querystring: AssetLibraryListQuery }>("/api/asset-library", async (request, reply) => {
    try {
      const dimension = parseDimension(request.query.dimension);
      const animated = parseBoolean(request.query.animated);
      const featured = parseBoolean(request.query.featured);
      const page = parseNumber(request.query.page);
      const pageSize = parseNumber(request.query.pageSize);
      return await catalog.list({
        ...(request.query.q ? { search: request.query.q } : {}),
        ...(dimension ? { dimension } : {}),
        ...(request.query.category ? { category: request.query.category } : {}),
        ...(animated !== undefined ? { animated } : {}),
        ...(featured !== undefined ? { featured } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    } catch (reason) {
      request.log.error({ reason }, "asset library catalog unavailable");
      return reply.code(503).send({ message: "素材目录暂不可用，请检查离线素材目录配置" });
    }
  });

  app.get<{ Params: { itemId: string } }>("/api/asset-library/items/:itemId", async (request, reply) => {
    const entry = await catalog.get(request.params.itemId).catch(() => undefined);
    return entry?.publicItem ?? reply.code(404).send({ message: "资源不存在，请从资源页重新选择" });
  });

  app.get<{ Params: { itemId: string } }>("/api/public/asset-library/items/:itemId/thumbnail", async (request, reply) => {
    let entry;
    try { entry = await catalog.get(request.params.itemId); }
    catch { return reply.code(503).send({ message: "素材目录暂时无法读取，请修复目录后重试" }); }
    if (!entry) return reply.code(404).send({ message: "素材不存在" });
    return reply.header("Cache-Control", "private, max-age=86400").type("image/png").send(createReadStream(entry.thumbnailPath));
  });

  app.get<{ Params: { itemId: string } }>("/api/asset-library/items/:itemId/preview", async (request, reply) => {
    const entry = await catalog.get(request.params.itemId).catch(() => undefined);
    if (!entry) return reply.code(404).send({ message: "素材不存在" });
    const previewPath = entry.modelPath ?? entry.thumbnailPath;
    return reply.header("Cache-Control", "private, max-age=3600").type(entry.modelPath ? "model/gltf-binary" : "image/png").send(createReadStream(previewPath));
  });

  app.get<{ Params: { itemId: string } }>("/api/asset-library/items/:itemId/maps", async (request, reply) => {
    const entry = await catalog.get(request.params.itemId).catch(() => undefined);
    if (!entry) return reply.code(404).send({ message: "素材不存在" });
    return (entry.assetFiles ?? []).filter(file => file.kind !== "thumbnail").map(file => ({
      kind: file.kind, name: file.fileName, mimeType: resourceMimeType(file.fileName), size: file.bytes,
      contentHash: file.sha256, url: `/api/asset-library/items/${encodeURIComponent(entry.publicItem.id)}/maps/${file.kind}`,
    }));
  });
  app.get<{ Params: { itemId: string; kind: string } }>("/api/asset-library/items/:itemId/maps/:kind", async (request, reply) => {
    const entry = await catalog.get(request.params.itemId).catch(() => undefined);
    const file = entry?.assetFiles?.find(item => item.kind !== "thumbnail" && item.kind === request.params.kind);
    if (!file) return reply.code(404).send({ message: "贴图不存在" });
    return reply.header("Cache-Control", "private, max-age=3600").type(resourceMimeType(file.fileName)).send(createReadStream(file.filePath));
  });

  app.post<{ Params: { projectId: string; itemId: string } }>("/api/projects/:projectId/asset-library/:itemId/import", async (request, reply) => {
    const project = dependencies.store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const entry = await catalog.get(request.params.itemId).catch(() => undefined);
    if (!entry) return reply.code(404).send({ message: "素材不存在或离线文件缺失" });
    if (entry.publicItem.publicationStatus === "deprecated") return reply.code(409).send({ message: "素材版本已废弃，请选择可用版本" });
    if (entry.publicItem.publicationStatus !== "published") return reply.code(409).send({ message: "素材待质量复核，暂不能导入" });
    const key = `${project.id}:${entry.kind}:${entry.contentHash}`;
    try {
      const active = imports.get(key);
      if (active) return reply.send({ ...await active, reused: true });
      const operation = resolveCatalogImport(dependencies, project, entry);
      imports.set(key, operation);
      try {
        const result = await operation;
        return reply.code(result.reused ? 200 : 201).send(result);
      } finally { if (imports.get(key) === operation) imports.delete(key); }
    } catch (reason) {
      request.log.error({ reason, itemId: entry.publicItem.id }, "asset library import failed");
      return reply.code(500).send({ message: reason instanceof Error ? reason.message : "素材导入失败" });
    }
  });
}

async function resolveCatalogImport(dependencies: AssetLibraryRouteDependencies, project: ProjectRecord, entry: AssetLibraryCatalogEntry): Promise<AssetLibraryImportResult> {
  if (entry.kind === "model") {
    const existing = project.models.find(model => importedLibraryItemId(model) === entry.publicItem.id || model.libraryOrigin?.contentHash === entry.contentHash);
    return existing ? { kind: "model", model: existing, reused: true }
      : { kind: "model", model: await importCatalogModel(dependencies, project.id, entry), reused: false };
  }
  const existing = (project.assets ?? []).find(asset => asset.libraryOrigin?.itemId === entry.publicItem.id || asset.libraryOrigin?.contentHash === entry.contentHash);
  return existing ? { kind: "resource", asset: existing, reused: true }
    : { kind: "resource", asset: await importCatalogResource(dependencies, project.id, entry), reused: false };
}

async function importCatalogModel(
  dependencies: AssetLibraryRouteDependencies,
  projectId: string,
  entry: AssetLibraryCatalogEntry,
): Promise<ModelRecord> {
  if (!entry.modelPath) throw new Error("模型素材缺少可导入文件");
  const modelId = randomUUID();
  const sourceName = `library-${entry.publicItem.id}.glb`;
  const modelDir = path.join(dependencies.dataDir, "projects", projectId, "models", modelId);
  const sourceDir = path.join(modelDir, "source");
  const sourcePath = path.join(sourceDir, sourceName);
  let modelPersisted = false;
  await mkdir(sourceDir, { recursive: true });
  try {
    await copyFile(entry.modelPath, sourcePath);
    // 核对实际将上传的副本，避免目录文件在校验与复制之间被替换。
    await assertFileHash(sourcePath, entry.contentHash);
    await dependencies.objects.putFile(`projects/${projectId}/models/${modelId}/source/${sourceName}`, sourcePath);
    const now = new Date().toISOString();
    const model: ModelRecord = {
      id: modelId,
      projectId,
      name: entry.publicItem.name,
      format: "glb",
      size: entry.publicItem.size,
      status: "queued",
      progress: 0,
      message: "正在导入素材并生成运行清单",
      sourceUrl: `/assets/projects/${projectId}/models/${modelId}/source/${sourceName}`,
      libraryOrigin: {
        itemId: entry.publicItem.id, contentHash: entry.contentHash, catalogVersion: 1,
        version: entry.publicItem.version, license: entry.publicItem.license,
        ...(entry.publicItem.attribution ? { attribution: entry.publicItem.attribution } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    await dependencies.store.addModel(projectId, model);
    modelPersisted = true;
    dependencies.queue.enqueue({ model, sourcePath, modelDir });
    return model;
  } catch (reason) {
    // 任一步失败都同时清理元数据、本地文件和对象存储，避免留下半导入资源。
    await Promise.allSettled([
      ...(modelPersisted ? [dependencies.store.removeModel(projectId, modelId)] : []),
      dependencies.objects.removePrefix(`projects/${projectId}/models/${modelId}`),
      rm(modelDir, { recursive: true, force: true }),
    ]);
    throw reason;
  }
}

async function importCatalogResource(
  dependencies: AssetLibraryRouteDependencies,
  projectId: string,
  entry: AssetLibraryCatalogEntry,
): Promise<ProjectAssetRecord> {
  if (!entry.assetFiles?.length || entry.kind === "model") throw new Error("资源素材缺少可导入文件");
  const assetId = randomUUID();
  const assetDir = path.join(dependencies.dataDir, "projects", projectId, "assets", assetId);
  const objectPrefix = `projects/${projectId}/assets/${assetId}`;
  await mkdir(assetDir, { recursive: true });
  try {
    const copied = [] as Array<{ source: (typeof entry.assetFiles)[number]; url: string }>;
    for (const source of entry.assetFiles) {
      const target = path.join(assetDir, source.fileName);
      await copyFile(source.filePath, target);
      await assertFileHash(target, source.sha256);
      await dependencies.objects.putFile(`${objectPrefix}/${source.fileName}`, target);
      copied.push({ source, url: `/assets/${objectPrefix}/${encodeURIComponent(source.fileName)}` });
    }
    const maps = copied.filter(({ source }) => source.kind !== "thumbnail").map(({ source, url }) => ({
      kind: source.kind as Exclude<typeof source.kind, "thumbnail">,
      name: source.fileName,
      mimeType: resourceMimeType(source.fileName),
      size: source.bytes,
      url,
      contentHash: source.sha256,
    }));
    const thumbnailUrl = copied.find(({ source }) => source.kind === "thumbnail")?.url;
    const now = new Date().toISOString();
    const asset: ProjectAssetRecord = {
      id: assetId,
      projectId,
      kind: entry.kind === "environment" ? "environment" : "pbr-material",
      name: entry.publicItem.name,
      fileName: entry.kind === "environment" ? maps[0]!.name : `${entry.publicItem.id}.pbr`,
      mimeType: entry.kind === "environment" ? maps[0]!.mimeType : "application/x-bim-pbr-material",
      size: entry.publicItem.size,
      url: maps[0]!.url,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      maps,
      libraryOrigin: {
        itemId: entry.publicItem.id,
        contentHash: entry.contentHash,
        catalogVersion: 1,
        version: entry.publicItem.version,
        license: entry.publicItem.license,
        publicationStatus: entry.publicItem.publicationStatus,
        ...(entry.publicItem.attribution ? { attribution: entry.publicItem.attribution } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    return await dependencies.store.saveAsset(projectId, asset);
  } catch (reason) {
    await Promise.allSettled([
      dependencies.objects.removePrefix(objectPrefix),
      rm(assetDir, { recursive: true, force: true }),
    ]);
    throw reason;
  }
}

async function assertFileHash(filePath: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest("hex") !== expected.toLowerCase()) throw new Error("资源文件完整性校验失败，请重新同步素材目录");
}

function resourceMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".hdr") return "image/vnd.radiance";
  if (extension === ".exr") return "image/x-exr";
  if (extension === ".png") return "image/png";
  return extension === ".webp" ? "image/webp" : "image/jpeg";
}

function importedLibraryItemId(model: ModelRecord): string | undefined {
  return model.libraryOrigin?.itemId ?? model.sourceUrl.match(/\/library-(industrial-\d+)\.glb$/)?.[1];
}

function parseDimension(value: string | undefined): AssetLibraryDimension | "all" | undefined {
  return value === "2d" || value === "3d" || value === "environment" || value === "material" || value === "effect" || value === "media" || value === "all" ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
