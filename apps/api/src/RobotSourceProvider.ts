import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelManifest, ModelRecord, RobotAssetDefinition } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { prepareRobotSource } from "./prepareRobotSource.js";

/** 机器人保留原始包和关节层级，不经过会合并节点的 GLB 优化链。 */
export class RobotSourceProvider {
  constructor(private readonly store: MetadataStore, private readonly objects: ObjectStore) {}

  async convert({ model, modelDir, sourcePath }: { model: ModelRecord; modelDir: string; sourcePath: string }): Promise<void> {
    await this.store.updateModel(model.projectId, model.id, { status: "processing", progress: 20, message: "正在校验机器人描述与资源" });
    const source = model.optimization ? this.store.getProject(model.projectId)?.models.find(item => item.id === model.optimization!.sourceModelId) : undefined;
    const entryPath = model.robotEntryPath ?? source?.manifest?.robot?.entryPath;
    const robot = await prepareRobotSource(sourcePath, { ...(entryPath ? { entryPath } : {}) });
    if (model.optimization) {
      if (model.format !== "zip" || !source?.manifest?.robot || source.status !== "ready" || source.updatedAt !== model.optimization.sourceUpdatedAt) throw new Error("机器人优化来源已失效，请重新选择原模型");
      assertLosslessRobotPackage(source.manifest.robot, robot);
    }
    const manifest: ModelManifest = { schemaVersion: 1, modelId: model.id, sourceName: model.name, sourceFormat: model.format,
      viewerKind: "urdf", geometryUrl: model.sourceUrl, robot, createdAt: new Date().toISOString() };
    const manifestPath = path.join(modelDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await this.objects.putFile(`projects/${model.projectId}/models/${model.id}/manifest.json`, manifestPath);
    await this.store.updateModel(model.projectId, model.id, { status: "ready", progress: 100, message: "可查看",
      robotEntryPath: robot.entryPath, manifest, manifestUrl: `/assets/projects/${model.projectId}/models/${model.id}/manifest.json` });
  }
}

/** 原始 XML 也在 resources 内；不允许改关节后仍标为无损压缩。 */
export function assertLosslessRobotPackage(source: RobotAssetDefinition, output: RobotAssetDefinition): void {
  const expected = new Map(source.resources.map(item => [item.path, item]));
  if (source.entryPath !== output.entryPath || !expected.size || expected.size !== source.resources.length || expected.size !== output.resources.length) throw new Error("机器人无损压缩改变了入口或资源清单");
  const seen = new Set<string>();
  for (const item of output.resources) {
    const original = expected.get(item.path);
    if (seen.has(item.path) || !original || original.size !== item.size || original.sha256 !== item.sha256) throw new Error(`机器人无损压缩改变了资源内容：${item.path}`);
    seen.add(item.path);
  }
}
