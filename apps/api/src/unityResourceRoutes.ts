import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import type { UnityBuildManifestRecord, UnityResourceRecord, UnityResourceVersionRecord, UnityRuntimeCapability } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";

const MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 12_000;

export async function registerUnityResourceRoutes(app: FastifyInstance, dependencies: { store: MetadataStore; objects: ObjectStore; dataDir: string }): Promise<void> {
  const { store, objects, dataDir } = dependencies;
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/unity-resources", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listUnityResources(request.params.projectId);
  });

  app.get<{ Params: { projectId: string; resourceId: string } }>("/api/projects/:projectId/unity-resources/:resourceId", async (request, reply) => {
    return store.getUnityResource(request.params.projectId, request.params.resourceId) ?? reply.code(404).send({ message: "Unity 资源不存在" });
  });

  app.post<{ Params: { projectId: string }; Querystring: { resourceId?: string; name?: string; unityVersion?: string } }>(
    "/api/projects/:projectId/unity-resources",
    async (request, reply) => {
      const project = store.getProject(request.params.projectId);
      if (!project) return reply.code(404).send({ message: "项目不存在" });
      const part = await request.file();
      if (!part) return reply.code(400).send({ message: "请选择 Unity WebGL ZIP" });
      if (path.extname(part.filename).toLowerCase() !== ".zip") {
        part.file.resume();
        return reply.code(415).send({ message: "Unity 资源必须是 ZIP 文件" });
      }
      const existing = request.query.resourceId ? store.getUnityResource(project.id, request.query.resourceId) : undefined;
      if (request.query.resourceId && !existing) {
        part.file.resume();
        return reply.code(404).send({ message: "要更新的 Unity 资源不存在" });
      }
      const resourceId = existing?.id ?? randomUUID();
      const versionId = randomUUID();
      const versionNumber = Math.max(0, ...(existing?.versions.map((item) => item.version) ?? [])) + 1;
      const root = path.join(dataDir, "projects", project.id, "unity", resourceId, versionId);
      try {
        const archive = await readUpload(part.file, MAX_COMPRESSED_BYTES);
        const contentHash = createHash("sha256").update(archive).digest("hex");
        const duplicate = existing?.versions.find((item) => item.contentHash === contentHash);
        if (existing && duplicate) {
          const now = new Date().toISOString();
          const resource = { ...existing, name: request.query.name?.trim() || existing.name, activeVersionId: duplicate.id, updatedAt: now };
          reply.header("x-bim-unity-deduplicated", "true");
          return reply.code(200).send(await store.saveUnityResource(project.id, resource));
        }
        const extracted = await extractUnityZip(archive, root);
        const baseKey = `projects/${project.id}/unity/${resourceId}/${versionId}`;
        const playerUrl = `/assets/${baseKey}/${encodeAssetPath(extracted.playerPath)}`;
        const manifestUrl = `/assets/${baseKey}/bim-studio.manifest.json`;
        const manifest: UnityBuildManifestRecord = { ...extracted.manifest, playerUrl: playerUrl };
        await writeFile(path.join(root, "bim-studio.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
        await objects.syncDirectory(baseKey, root);
        const now = new Date().toISOString();
        const version: UnityResourceVersionRecord = {
          id: versionId,
          resourceId,
          version: versionNumber,
          sourceFileName: cleanFileName(part.filename),
          contentHash,
          size: archive.byteLength,
          fileCount: extracted.fileCount,
          playerUrl,
          manifestUrl,
          manifest,
          diagnostics: extracted.diagnostics,
          createdAt: now,
        };
        const resource: UnityResourceRecord = existing
          ? { ...existing, name: request.query.name?.trim() || existing.name, activeVersionId: version.id, versions: [version, ...existing.versions], updatedAt: now }
          : {
              id: resourceId,
              projectId: project.id,
              name: request.query.name?.trim() || path.basename(part.filename, path.extname(part.filename)),
              activeVersionId: version.id,
              versions: [version],
              createdAt: now,
              updatedAt: now,
            };
        return reply.code(201).send(await store.saveUnityResource(project.id, resource));
      } catch (reason) {
        await rm(root, { recursive: true, force: true });
        return reply.code(400).send({ message: reason instanceof Error ? reason.message : "Unity 资源导入失败" });
      }
    },
  );

  app.post<{ Params: { projectId: string; resourceId: string; versionId: string } }>(
    "/api/projects/:projectId/unity-resources/:resourceId/versions/:versionId/activate",
    async (request, reply) => {
      return (
        (await store.activateUnityResourceVersion(request.params.projectId, request.params.resourceId, request.params.versionId)) ??
        reply.code(404).send({ message: "Unity 资源版本不存在" })
      );
    },
  );

  app.delete<{ Params: { projectId: string; resourceId: string } }>("/api/projects/:projectId/unity-resources/:resourceId", async (request, reply) => {
    const removed = await store.removeUnityResource(request.params.projectId, request.params.resourceId);
    if (!removed) return reply.code(404).send({ message: "Unity 资源不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}/unity/${request.params.resourceId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId, "unity", request.params.resourceId), { recursive: true, force: true });
    return reply.code(204).send();
  });
}

export async function extractUnityZip(
  archive: Buffer,
  target: string,
): Promise<{ playerPath: string; manifest: UnityBuildManifestRecord; diagnostics: string[]; fileCount: number }> {
  const zip = await JSZip.loadAsync(archive, { createFolders: true, checkCRC32: true });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length === 0) throw new Error("ZIP 中没有 Unity 构建文件");
  if (files.length > MAX_FILES) throw new Error(`Unity ZIP 文件数量超过 ${MAX_FILES}`);
  const normalized = files.map((entry) => ({ entry, path: safeArchivePath(entry.name) }));
  const commonRoot = commonDirectory(normalized.map((item) => item.path));
  await mkdir(target, { recursive: true });
  let uncompressedBytes = 0;
  const outputPaths: string[] = [];
  for (const item of normalized) {
    const relative = commonRoot && item.path.startsWith(`${commonRoot}/`) ? item.path.slice(commonRoot.length + 1) : item.path;
    const data = await item.entry.async("nodebuffer");
    uncompressedBytes += data.byteLength;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Unity ZIP 解压后超过 2 GiB 限制");
    const output = path.join(target, ...relative.split("/"));
    const resolved = path.resolve(output);
    const root = path.resolve(target);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Unity ZIP 包含越界路径");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, data, { flag: "wx" });
    outputPaths.push(relative);
  }
  const playerPath = choosePlayer(outputPaths);
  const manifestPath = chooseManifest(outputPaths);
  const diagnostics: string[] = [];
  let source: unknown;
  if (manifestPath) {
    try {
      source = JSON.parse(await readFile(path.join(target, ...manifestPath.split("/")), "utf8"));
    } catch {
      diagnostics.push("构建清单无法解析，已根据播放器入口生成基础清单");
    }
  } else diagnostics.push("未发现构建清单，场景、事件和数据层需要在 Unity Editor Package 中导出");
  return { playerPath, manifest: normalizeManifest(source, playerPath, diagnostics), diagnostics, fileCount: files.length };
}

function normalizeManifest(value: unknown, playerPath: string, diagnostics: string[]): UnityBuildManifestRecord {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (source.bridgeVersion !== undefined && source.bridgeVersion !== 1) throw new Error("Unity Bridge 协议版本不受支持");
  const strings = (candidate: unknown) => (Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : undefined);
  const layers = Array.isArray(source.dataLayers)
    ? source.dataLayers.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.key !== "string") return [];
        return [
          {
            key: record.key,
            ...(typeof record.description === "string" ? { description: record.description } : {}),
            ...(typeof record.keyField === "string" ? { keyField: record.keyField } : {}),
            ...(typeof record.target === "string" ? { target: record.target } : {}),
          },
        ];
      })
    : undefined;
  const objects = Array.isArray(source.objects)
    ? source.objects.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string") return [];
        const tags = Array.isArray(record.tags) ? record.tags.filter((tag: unknown): tag is string => typeof tag === "string" && Boolean(tag.trim())) : undefined;
        return [
          {
            id: record.id,
            ...(typeof record.name === "string" ? { name: record.name } : {}),
            ...(typeof record.path === "string" ? { path: record.path } : {}),
            ...(tags?.length ? { tags } : {}),
          },
        ];
      })
    : undefined;
  const properties = Array.isArray(source.properties)
    ? source.properties.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.key !== "string" || !["string", "number", "boolean", "color", "select"].includes(String(record.type))) return [];
        const options = Array.isArray(record.options) ? record.options.filter((option: unknown): option is string => typeof option === "string") : undefined;
        return [
          {
            key: record.key,
            type: String(record.type) as "string" | "number" | "boolean" | "color" | "select",
            ...(typeof record.label === "string" ? { label: record.label } : {}),
            ...(typeof record.target === "string" ? { target: record.target } : {}),
            ...(options?.length ? { options } : {}),
          },
        ];
      })
    : undefined;
  const runtimeCapabilities = strings(source.runtimeCapabilities)?.filter((item): item is UnityRuntimeCapability =>
    ["ack", "heartbeat", "data-layers", "properties", "actions", "events"].includes(item),
  );
  if (!strings(source.events)?.length) diagnostics.push("未声明可绑定事件");
  return {
    schemaVersion: 1,
    bridgeVersion: 1,
    playerUrl: playerPath,
    ...(typeof source.unityVersion === "string" ? { unityVersion: source.unityVersion } : {}),
    ...(strings(source.scenes)?.length ? { scenes: strings(source.scenes)! } : {}),
    ...(strings(source.events)?.length ? { events: strings(source.events)! } : {}),
    ...(layers?.length ? { dataLayers: layers } : {}),
    ...(strings(source.actions)?.length ? { actions: strings(source.actions)! } : {}),
    ...(objects?.length ? { objects } : {}),
    ...(properties?.length ? { properties } : {}),
    ...(runtimeCapabilities?.length ? { runtimeCapabilities } : {}),
  };
}

async function readUpload(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Unity ZIP 超过 512 MiB 导入限制");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function safeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || !part))
    throw new Error(`Unity ZIP 包含不安全路径：${value}`);
  return normalized;
}

function commonDirectory(paths: string[]): string | undefined {
  const first = paths[0]?.split("/")[0];
  return first && paths.every((item) => item.includes("/") && item.split("/")[0] === first) ? first : undefined;
}

function choosePlayer(paths: string[]): string {
  const candidates = paths
    .filter((item) => path.posix.basename(item).toLowerCase() === "index.html")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  if (!candidates[0]) throw new Error("ZIP 中没有 Unity WebGL index.html");
  return candidates[0];
}

function chooseManifest(paths: string[]): string | undefined {
  return (
    paths.find((item) => path.posix.basename(item).toLowerCase() === "bim-studio.manifest.json") ??
    paths.find((item) => path.posix.basename(item).toLowerCase() === "manifest.json")
  );
}

function cleanFileName(value: string): string {
  return (
    path
      .basename(value)
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .slice(0, 180) || "unity-build.zip"
  );
}
function encodeAssetPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
