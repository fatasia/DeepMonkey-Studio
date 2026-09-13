import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { ProjectAssetMapKind, ProjectAssetMapRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { ObjectStore } from "./objects.js";
import { cleanFileName, imageContentType } from "./routeFileTypes.js";

interface Dependencies { store: MetadataStore; objects: ObjectStore; dataDir: string }
const materialMapKinds = new Set<ProjectAssetMapKind>(["base-color", "normal", "roughness", "metalness", "ao"]);

export function registerAppearanceAssetUpload(app: FastifyInstance, dependencies: Dependencies) {
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/assets/materials", async (request, reply) => {
    if (!dependencies.store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const parts = request.parts({ limits: { files: 5, fileSize: 32 * 1024 * 1024, fields: 0 } });
    async function* maps() {
      for await (const part of parts) {
        if (part.type !== "file") throw new Error("材质上传只接受贴图文件");
        const kind = part.fieldname as ProjectAssetMapKind;
        if (!materialMapKinds.has(kind)) { part.file.resume(); throw new Error("请选择贴图用途：基础色、法线、粗糙度、金属度或 AO"); }
        yield { kind, part };
      }
    }
    try { return reply.code(201).send(await saveAppearanceAsset(dependencies, request.params.projectId, "pbr-material", maps())); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : "材质上传失败" }); }
  });
}

/** 环境与材质都进入项目资源目录，删除、发布依赖和刷新恢复复用同一资源合同。 */
export async function saveAppearanceAsset(
  dependencies: Dependencies, projectId: string, kind: "environment" | "pbr-material",
  parts: AsyncIterable<{ kind: ProjectAssetMapKind; part: MultipartFile }>,
): Promise<ProjectAssetRecord> {
  const id = randomUUID();
  const prefix = `projects/${projectId}/assets/${id}`;
  const directory = path.join(dependencies.dataDir, "projects", projectId, "assets", id);
  const maps: ProjectAssetMapRecord[] = [];
  await mkdir(directory, { recursive: true });
  try {
    for await (const entry of parts) {
      const { part } = entry;
      if (maps.some(map => map.kind === entry.kind)) { part.file.resume(); throw new Error("同一种用途只能上传一张贴图"); }
      const extension = path.extname(part.filename).toLowerCase();
      const mimeType = kind === "environment" && extension === ".hdr" ? "image/vnd.radiance"
        : kind === "environment" && extension === ".exr" ? "image/x-exr"
          : [".jpg", ".jpeg", ".png", ".webp"].includes(extension) ? imageContentType(extension) : undefined;
      if (!mimeType) { part.file.resume(); throw new Error(kind === "environment" ? "环境支持 HDR、EXR、JPG、PNG、WEBP" : "材质贴图支持 JPG、PNG、WEBP"); }
      const name = cleanFileName(part.filename);
      const fileName = `${entry.kind}-${name}`;
      const filePath = path.join(directory, fileName);
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { callback(new Error("单张贴图不能超过 64 MB")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(part.file, meter, createWriteStream(filePath, { flags: "wx" }));
      if (part.file.truncated || bytes === 0) throw new Error("贴图为空或超过上传限制");
      await dependencies.objects.putFile(`${prefix}/${fileName}`, filePath);
      maps.push({ kind: entry.kind, name, mimeType, size: bytes, url: `/assets/${prefix}/${encodeURIComponent(fileName)}`, contentHash: hash.digest("hex") });
    }
    const primary = maps.find(map => map.kind === (kind === "environment" ? "environment" : "base-color"));
    if (!primary) throw new Error(kind === "environment" ? "请选择环境贴图" : "请上传基础色贴图");
    const now = new Date().toISOString();
    return await dependencies.store.saveAsset(projectId, {
      id, projectId, kind, name: primary.name, fileName: primary.name, mimeType: primary.mimeType,
      url: primary.url, size: maps.reduce((sum, map) => sum + map.size, 0), maps,
      ...(primary.mimeType.startsWith("image/") && !["image/vnd.radiance", "image/x-exr"].includes(primary.mimeType) ? { thumbnailUrl: primary.url } : {}),
      createdAt: now, updatedAt: now,
    });
  } catch (error) {
    await dependencies.objects.removePrefix(prefix);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
