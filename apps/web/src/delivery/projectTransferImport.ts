import type { ProjectRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { readRecoveryRecord, writeRecoveryRecord } from "../studio/recoveryDatabase";
import { transferSha256, type ProjectTransferArchive } from "./projectTransferArchive";
import { allocateTransferIdentities, remapTransferApplication, remapTransferScene, remapTransferValue, type TransferMapping } from "./projectTransferRemap";
import { safeSimulationConfig, sanitizeTransferContent, validateProjectTransfer } from "./projectTransferModel";

type TransferApi = Pick<typeof api, "createProject" | "getProject" | "uploadModel" | "renameModel" | "uploadImageAsset" | "uploadVideoAsset"
  | "uploadEnvironmentMap" | "uploadMaterialAsset" | "uploadScriptDependency" | "createDataConnection" | "createDataset" | "saveDataPipeline"
  | "saveScene" | "getApplication" | "createApplication" | "saveApplication" | "renameAsset">;
interface ImportCheckpoint { key: string; mapping: TransferMapping; completed: string[]; finished?: boolean; modelFileHashes?: Record<string, string>; fileHashes?: Record<string, string>; }

export class ProjectTransferImport {
  private checkpoint?: ImportCheckpoint;
  constructor(readonly archive: ProjectTransferArchive, private client: TransferApi = api) {}

  replaceFile(fileId: string, file: File) {
    this.archive.files.set(fileId, file);
    if (!this.checkpoint) return;
    const affected = [
      ...this.archive.document.models.filter(item => item.fileId === fileId).map(item => `model:${item.originalId}`),
      ...this.archive.document.assets.filter(item => item.fileId === fileId || Object.values(item.maps ?? {}).includes(fileId)).map(item => `asset:${item.originalId}`),
      ...this.archive.document.dependencies.filter(item => item.fileId === fileId).map(item => `dependency:${item.originalId}`),
      ...this.archive.document.scenes.map(item => `scene:${item.id}`),
      ...this.archive.document.applications.map(item => `application:${item.metadata.id}`),
    ];
    this.checkpoint.completed = this.checkpoint.completed.filter(id => !affected.includes(id));
  }

  async run(name: string, signal: AbortSignal, progress: (message: string) => void): Promise<ProjectRecord> {
    validateProjectTransfer(this.archive.document);
    const missing = this.archive.document.files.filter(file => !this.archive.files.has(file.id));
    if (missing.length) throw new Error(`请先补齐 ${missing.length} 个资源文件`);
    const hash = await transferSha256(new TextEncoder().encode(JSON.stringify(this.archive.document)).buffer);
    const key = `project-transfer:${hash}`;
    if (!this.checkpoint) {
      const stored = await readRecoveryRecord(key).catch(() => undefined) as ImportCheckpoint | undefined;
      if (stored?.key === key && !stored.finished && stored.mapping?.projectId && Array.isArray(stored.completed)) {
        const exists = await this.client.getProject(stored.mapping.projectId).catch(error => {
          if (error instanceof Error && /404|不存在/.test(error.message)) return undefined;
          throw error;
        });
        if (exists) this.checkpoint = stored;
      }
      if (!this.checkpoint) {
        signal.throwIfAborted();
        const project = await this.client.createProject(name.trim(), this.archive.document.project.description);
        this.checkpoint = { key, mapping: { projectId: project.id, models: {}, assets: {}, urls: {}, dependencies: {}, identities: allocateTransferIdentities(this.archive.document) }, completed: [] };
        await this.persist();
      }
    }
    const { mapping } = this.checkpoint;
    const document = this.archive.document;
    // 刷新后重新选包/替代文件也必须使旧步骤失效，不能只在同一个弹窗实例里处理替换。
    for (const file of document.files) {
      signal.throwIfAborted();
      const hash = await transferSha256(await this.file(file.id).arrayBuffer());
      const previous = this.checkpoint.fileHashes?.[file.id];
      if (previous && previous !== hash) this.replaceFile(file.id, this.file(file.id));
      (this.checkpoint.fileHashes ??= {})[file.id] = hash;
    }
    await this.persist();
    for (const model of document.models) await this.step(`model:${model.originalId}`, `导入模型 ${model.name}`, signal, progress, async () => {
      const file = this.file(model.fileId);
      const hash = this.checkpoint!.fileHashes![model.fileId]!;
      let id = this.checkpoint!.modelFileHashes?.[model.originalId] === hash ? mapping.models[model.originalId] : undefined;
      if (!id) {
        const uploaded = await this.client.uploadModel(mapping.projectId, file, undefined, undefined, undefined, model.robotEntryPath);
        id = uploaded.id; mapping.models[model.originalId] = id;
        (this.checkpoint!.modelFileHashes ??= {})[model.originalId] = hash;
        await this.persist();
      }
      await this.waitForModel(id, signal);
      await this.client.renameModel(mapping.projectId, id, model.name);
    });
    for (const asset of document.assets) await this.step(`asset:${asset.originalId}`, `导入资源 ${asset.name}`, signal, progress, async () => {
      const file = this.file(asset.fileId);
      if (asset.kind === "environment") {
        const uploaded = await this.client.uploadEnvironmentMap(mapping.projectId, file);
        mapping.urls[this.sourceUrl(asset.fileId)] = uploaded.url;
        const project = await this.client.getProject(mapping.projectId);
        const record = project.assets?.find(item => item.url === uploaded.url);
        if (record) { mapping.assets[asset.originalId] = record.id; await this.client.renameAsset(mapping.projectId, record.id, asset.name); }
      } else {
        const uploaded = asset.kind === "pbr-material"
          ? await this.client.uploadMaterialAsset(mapping.projectId, Object.fromEntries(Object.entries(asset.maps ?? {}).filter(([kind]) => kind !== "environment").map(([kind, id]) => [kind, this.file(id)])))
          : asset.kind === "video" ? await this.client.uploadVideoAsset(mapping.projectId, file) : await this.client.uploadImageAsset(mapping.projectId, file);
        mapping.assets[asset.originalId] = uploaded.id;
        await this.client.renameAsset(mapping.projectId, uploaded.id, asset.name);
        mapping.urls[this.sourceUrl(asset.fileId)] = uploaded.url;
        for (const map of uploaded.maps ?? []) {
          const oldFileId = asset.maps?.[map.kind];
          if (oldFileId) mapping.urls[this.sourceUrl(oldFileId)] = map.url;
        }
      }
    });
    for (const dependency of document.dependencies) await this.step(`dependency:${dependency.originalId}`, `导入脚本依赖 ${dependency.specifier}`, signal, progress, async () => {
      mapping.dependencies[dependency.originalId] = await this.client.uploadScriptDependency(
        mapping.projectId, dependency.specifier, this.file(dependency.fileId), { prepared: true },
      );
    });
    for (const connection of document.runtime.connections) await this.step(`connection:${connection.id}`, `准备数据连接 ${connection.name}`, signal, progress, async () => {
      await this.client.createDataConnection(mapping.projectId, { ...connection, id: mapping.identities[connection.id]!, projectId: mapping.projectId,
        enabled: connection.type === "simulation" && connection.enabled, config: connection.type === "simulation" ? safeSimulationConfig(connection.config) : {} });
    });
    for (const dataset of document.runtime.datasets) await this.step(`dataset:${dataset.id}`, `准备数据集 ${dataset.name}`, signal, progress, async () => {
      const safe = { id: mapping.identities[dataset.id]!, projectId: mapping.projectId, connectionId: mapping.identities[dataset.connectionId]!,
        name: dataset.name, refreshSeconds: dataset.refreshSeconds, fields: dataset.fields,
        ...(dataset.query !== undefined ? { query: dataset.query } : {}),
        ...(dataset.sourceKey !== undefined ? { sourceKey: dataset.sourceKey } : {}),
        ...(dataset.computedFields ? { computedFields: sanitizeTransferContent(dataset.computedFields) } : {}) };
      await this.client.createDataset(mapping.projectId, safe);
    });
    for (const pipeline of document.runtime.pipelines) await this.step(`pipeline:${pipeline.id}`, `准备管道 ${pipeline.name}`, signal, progress, async () => {
      const transferred = remapTransferValue(sanitizeTransferContent(pipeline), mapping);
      await this.client.saveDataPipeline(mapping.projectId, { ...transferred, id: mapping.identities[pipeline.id]!, projectId: mapping.projectId });
    });
    for (const scene of document.scenes) await this.step(`scene:${scene.id}`, `保存场景 ${scene.name}`, signal, progress, async () => {
      await this.client.saveScene(remapTransferScene(sanitizeTransferContent(scene), mapping));
    });
    for (const application of document.applications) await this.step(`application:${application.metadata.id}`, `保存应用 ${application.metadata.name}`, signal, progress, async () => {
      const target = remapTransferApplication(sanitizeTransferContent(application), mapping);
      // 请求响应丢失后的重试先查询已分配的 ID，避免重复创建应用。
      const existing = await this.client.getApplication(mapping.projectId, target.metadata.id).catch(error => {
        if (error instanceof Error && /404|不存在/.test(error.message)) return undefined;
        throw error;
      });
      if (!existing) await this.client.createApplication(target);
      else await this.client.saveApplication({ ...target, metadata: { ...target.metadata, revision: existing.metadata.revision } });
    });
    const result = await this.client.getProject(mapping.projectId);
    signal.throwIfAborted();
    this.checkpoint.finished = true; await this.persist();
    progress("项目导入完成");
    return result;
  }

  private file(id: string): File {
    const file = this.archive.files.get(id);
    if (!file) throw new Error(`文件尚未补齐：${id}`);
    return file;
  }
  private sourceUrl(id: string): string { return this.archive.document.files.find(file => file.id === id)?.sourceUrl ?? ""; }
  private async persist() { if (this.checkpoint) await writeRecoveryRecord(this.checkpoint).catch(() => undefined); }
  private async step(id: string, message: string, signal: AbortSignal, progress: (message: string) => void, action: () => Promise<void>) {
    signal.throwIfAborted();
    if (this.checkpoint!.completed.includes(id)) return;
    progress(message); await action();
    this.checkpoint!.completed.push(id); await this.persist();
  }
  private async waitForModel(id: string, signal: AbortSignal) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const model = (await this.client.getProject(this.checkpoint!.mapping.projectId)).models.find(item => item.id === id);
      if (model?.status === "ready") return;
      if (model?.status === "failed") throw new Error(model.message || "模型转换失败，请选择可用文件后重试");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("模型处理超时，可稍后重试继续导入");
  }
}
