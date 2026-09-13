import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./store.js";
import type { ObjectStore } from "./objects.js";

interface Dependencies { store: MetadataStore; objects: ObjectStore; dataDir: string }

/** 缩略图独立存储；唯一版本路径避免缓存旧图，保存失败保留原封面。 */
export function registerResourceThumbnailRoutes(app: FastifyInstance, { store, objects, dataDir }: Dependencies) {
  for (const collection of ["models", "assets"] as const) {
    app.post<{ Params: { projectId: string; resourceId: string } }>(`/api/projects/:projectId/${collection}/:resourceId/thumbnail`, async (request, reply) => {
      const { projectId, resourceId } = request.params;
      const read = () => collection === "models" ? store.getProject(projectId)?.models.find(item => item.id === resourceId)
        : store.listAssets(projectId).find(item => item.id === resourceId);
      if (!read()) return reply.code(404).send({ message: "资源不存在" });
      let bytes: Buffer;
      try {
        const part = await request.file({ limits: { files: 1, fileSize: 8 * 1024 * 1024, fields: 0 } });
        if (!part) return reply.code(400).send({ message: "请选择缩略图" });
        const source = await part.toBuffer();
        const image = sharp(source, { limitInputPixels: 40_000_000 });
        const metadata = await image.metadata();
        if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("请选择 PNG、JPG 或 WEBP 图片");
        bytes = await image.rotate().resize(640, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
      } catch {
        return reply.code(400).send({ message: "缩略图无法读取，请选择 8 MB 以内的 PNG、JPG 或 WEBP 图片" });
      }
      const key = `projects/${projectId}/${collection}/${resourceId}/thumbnails/${randomUUID()}.webp`;
      const filePath = path.resolve(dataDir, key);
      const root = path.resolve(dataDir, "projects") + path.sep;
      if (!filePath.startsWith(root)) return reply.code(400).send({ message: "资源路径无效" });
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, bytes, { flag: "wx" });
        await objects.putFile(key, filePath);
        // 上传期间可能发生重命名或删除，以最新记录合并封面，禁止恢复已删除资源。
        const current = read();
        if (!current) throw new Error("资源已删除，请刷新列表");
        const thumbnailUrl = `/assets/${key}`;
        return collection === "models"
          ? await store.updateModel(projectId, resourceId, { thumbnailUrl })
          : await store.saveAsset(projectId, { ...current as import("@bim-studio/contracts").ProjectAssetRecord, thumbnailUrl, updatedAt: new Date().toISOString() });
      } catch (error) {
        await objects.removePrefix(key).catch(() => undefined);
        await rm(filePath, { force: true }).catch(() => undefined);
        request.log.warn({ error, resourceId }, "thumbnail save failed");
        return reply.code(503).send({ message: "缩略图保存失败，原缩略图已保留，请重试" });
      }
    });
  }
}
